/**
 * Robot Mill — Agent & Chain Helpers
 * 
 * Parses agent definitions and chain configurations.
 * Executes agent chains by spawning Pi subprocesses.
 */

import { spawn } from "child_process";
import { readFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { AgentDef, ChainDef, ChainStep, RobotState, StepState } from "../types.ts";
import { parseFrontmatter } from "./markdown.ts";
import { setStepRunning, setStepError, advanceStep, finishExecution } from "../state.ts";

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT PARSING
// ═══════════════════════════════════════════════════════════════════════════════

export function parseAgentFile(filePath: string): AgentDef | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const { frontmatter, content } = parseFrontmatter(raw);

    if (!frontmatter.name) return null;

    return {
      name: frontmatter.name as string,
      description: (frontmatter.description as string) || "",
      tools: (frontmatter.tools as string) || "read,grep,find,ls",
      systemPrompt: content.trim(),
    };
  } catch {
    return null;
  }
}

export function scanAgents(dirs: string[]): Map<string, AgentDef> {
  const agents = new Map<string, AgentDef>();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;

    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      // Skip teams/chains YAML files
      if (file.endsWith(".yaml") || file.endsWith(".yml")) continue;

      const def = parseAgentFile(join(dir, file));
      if (def && !agents.has(def.name.toLowerCase())) {
        agents.set(def.name.toLowerCase(), def);
      }
    }
  }

  return agents;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAIN PARSING
// ═══════════════════════════════════════════════════════════════════════════════

export function parseChainYaml(raw: string): ChainDef[] {
  const chains: ChainDef[] = [];
  let current: ChainDef | null = null;
  let currentStep: ChainStep | null = null;

  for (const line of raw.split("\n")) {
    // Skip comments and empty lines at top level
    if (line.match(/^\s*#/) || !line.trim()) continue;

    // New chain definition
    const chainMatch = line.match(/^(\S[^:]*):$/);
    if (chainMatch) {
      if (current && currentStep) current.steps.push(currentStep);
      current = { name: chainMatch[1].trim(), description: "", steps: [] };
      chains.push(current);
      currentStep = null;
      continue;
    }

    // Chain description
    const descMatch = line.match(/^\s+description:\s+["']?(.+?)["']?\s*$/);
    if (descMatch && current && !currentStep) {
      current.description = descMatch[1];
      continue;
    }

    // Steps array marker
    if (line.match(/^\s+steps:\s*$/) && current) continue;

    // New step - agent
    const agentMatch = line.match(/^\s+-\s+agent:\s+(.+)$/);
    if (agentMatch && current) {
      if (currentStep) current.steps.push(currentStep);
      currentStep = { agent: agentMatch[1].trim(), prompt: "" };
      continue;
    }

    // Step prompt
    const promptMatch = line.match(/^\s+prompt:\s+["']?(.+?)["']?\s*$/);
    if (promptMatch && currentStep) {
      currentStep.prompt = promptMatch[1].replace(/\\n/g, "\n");
      continue;
    }
  }

  // Don't forget the last step
  if (current && currentStep) current.steps.push(currentStep);

  return chains;
}

export function loadChains(cwd: string): ChainDef[] {
  const chainPath = join(cwd, ".pi", "agents", "mill-chains.yaml");
  if (!existsSync(chainPath)) return [];

  try {
    return parseChainYaml(readFileSync(chainPath, "utf-8"));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGENT EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

interface AgentResult {
  output: string;
  exitCode: number;
  elapsed: number;
}

export function runAgent(
  agentDef: AgentDef,
  prompt: string,
  sessionDir: string,
  model: string,
  onOutput?: (chunk: string) => void
): Promise<AgentResult> {
  const agentKey = agentDef.name.toLowerCase().replace(/\s+/g, "-");
  const sessionFile = join(sessionDir, `mill-${agentKey}.json`);

  const args = [
    "--mode", "json",
    "-p",
    "--no-extensions",
    "--model", model,
    "--tools", agentDef.tools,
    "--thinking", "off",
    "--append-system-prompt", agentDef.systemPrompt,
    "--session", sessionFile,
    prompt,
  ];

  const startTime = Date.now();
  const textChunks: string[] = [];

  return new Promise((resolve) => {
    const proc = spawn("pi", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buffer = "";
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") {
              const text = delta.delta || "";
              textChunks.push(text);
              onOutput?.(text);
            }
          }
        } catch {
          /* ignore parse errors */
        }
      }
    });

    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", () => {
      /* ignore stderr */
    });

    proc.on("close", (code) => {
      resolve({
        output: textChunks.join(""),
        exitCode: code ?? 1,
        elapsed: Date.now() - startTime,
      });
    });

    proc.on("error", (err) => {
      resolve({
        output: `Error: ${err.message}`,
        exitCode: 1,
        elapsed: Date.now() - startTime,
      });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHAIN EXECUTION
// ═══════════════════════════════════════════════════════════════════════════════

interface ChainResult {
  output: string;
  success: boolean;
  elapsed: number;
  /** Output from each step for saving to task notes */
  stepOutputs: { agent: string; output: string; elapsed: number }[];
}

interface ChainCallbacks {
  /** Called when new output arrives from an agent */
  onStepOutput?: (stepIndex: number, chunk: string, fullOutput: string) => void;
  /** Called when a step completes successfully */
  onStepComplete?: (stepIndex: number, agent: string, output: string, elapsed: number) => void;
}

const MAX_RECENT_LINES = 5;

export async function runChain(
  chain: ChainDef,
  taskPrompt: string,
  state: RobotState,
  sessionDir: string,
  model: string,
  callbacks?: ChainCallbacks
): Promise<ChainResult> {
  const chainStart = Date.now();
  let input = taskPrompt;
  const original = taskPrompt;
  const stepOutputs: ChainResult["stepOutputs"] = [];

  // Ensure session directory exists
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  // Clear old session files
  for (const f of readdirSync(sessionDir)) {
    if (f.startsWith("mill-") && f.endsWith(".json")) {
      try {
        unlinkSync(join(sessionDir, f));
      } catch {
        /* ignore */
      }
    }
  }

  for (let i = 0; i < chain.steps.length; i++) {
    const step = chain.steps[i];
    const stepState = state.execution.steps[i];
    setStepRunning(state, i);

    // Initialize step state for tracking
    stepState.fullOutput = "";
    stepState.recentLines = [];

    // Substitute variables in prompt
    const prompt = step.prompt
      .replace(/\$INPUT/g, input)
      .replace(/\$ORIGINAL/g, original);

    // Find agent definition
    const agentDef = state.agents.get(step.agent.toLowerCase());
    if (!agentDef) {
      const error = `Agent "${step.agent}" not found`;
      setStepError(state, i, error);
      return {
        output: `Error: ${error}`,
        success: false,
        elapsed: Date.now() - chainStart,
        stepOutputs,
      };
    }

    // Run the agent with output tracking
    const result = await runAgent(
      agentDef,
      prompt,
      sessionDir,
      model,
      (chunk) => {
        // Accumulate full output
        stepState.fullOutput += chunk;
        
        // Update recent lines for widget display
        const allLines = stepState.fullOutput.split("\n").filter(Boolean);
        stepState.recentLines = allLines.slice(-MAX_RECENT_LINES);
        stepState.lastOutput = allLines[allLines.length - 1] || "";
        
        // Notify callback
        callbacks?.onStepOutput?.(i, chunk, stepState.fullOutput);
      }
    );

    if (result.exitCode !== 0) {
      setStepError(state, i, result.output.slice(0, 200));
      return {
        output: result.output,
        success: false,
        elapsed: Date.now() - chainStart,
        stepOutputs,
      };
    }

    // Store step output for later saving to task
    stepOutputs.push({
      agent: step.agent,
      output: result.output,
      elapsed: result.elapsed,
    });

    // Notify step completion
    callbacks?.onStepComplete?.(i, step.agent, result.output, result.elapsed);

    // Advance to next step
    advanceStep(state, result.output);
    input = result.output;
  }

  finishExecution(state, true);
  return {
    output: input,
    success: true,
    elapsed: Date.now() - chainStart,
    stepOutputs,
  };
}
