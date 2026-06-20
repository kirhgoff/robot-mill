import { useState, useMemo, useEffect } from "react";
import { api, type Variation, type ChatMessage as ApiChatMessage } from "../api/client";
import { useWebSocket } from "../hooks/useWebSocket";
import { ChatMessageList, type ChatMessage } from "./ChatMessageList";
import { ChatInputRow } from "./ChatInputRow";

interface Props {
	variation: Variation;
}

export function ChatPanel({ variation }: Props) {
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
	const [persistedMessages, setPersistedMessages] = useState<ChatMessage[]>([]);
	const { messages: wsMessages } = useWebSocket(variation.agentId);

	// Load persisted message history on mount / variation change
	useEffect(() => {
		let cancelled = false;
		api.getMessages(variation.id)
			.then(({ messages }) => {
				if (cancelled) return;
				setPersistedMessages(
					messages.map((m: ApiChatMessage) => ({
						role: m.role,
						text: m.text,
						timestamp: m.timestamp,
					})),
				);
			})
			.catch(() => {
				// ignore — will fall back to just the initial prompt
			});
		return () => { cancelled = true; };
	}, [variation.id]);

	const displayMessages = useMemo(() => {
		// Start with persisted history (which already includes the initial prompt)
		const msgs: ChatMessage[] = persistedMessages.length > 0
			? [...persistedMessages]
			: [
				{
					role: "user",
					text: variation.initialPrompt,
					timestamp: variation.createdAt,
				},
			];

		// Append any locally-added messages (from sending new chats this session)
		msgs.push(...chatHistory);

		// Append live streaming WS messages
		let assistantText = "";
		for (const msg of wsMessages) {
			if (msg.type === "text") {
				assistantText += msg.data as string;
			} else if (msg.type === "message_complete") {
				msgs.push({
					role: "assistant",
					text: assistantText.trim() || (msg.data as string),
					timestamp: msg.timestamp,
				});
				assistantText = "";
			} else if (msg.type === "tool_start") {
				const data = msg.data as { toolName?: string };
				msgs.push({
					role: "system",
					text: `🔧 Running: ${data.toolName || "tool"}`,
					timestamp: msg.timestamp,
				});
			}
		}

		if (assistantText.trim()) {
			msgs.push({
				role: "assistant",
				text: `${assistantText.trim()} ▍`,
				timestamp: Date.now(),
			});
		}

		return msgs;
	}, [persistedMessages, chatHistory, wsMessages, variation]);

	const handleSend = async () => {
		const message = input.trim();
		if (!message || sending) return;

		setSending(true);
		setInput("");
		setChatHistory((prev) => [
			...prev,
			{ role: "user", text: message, timestamp: Date.now() },
		]);

		try {
			await api.chat(variation.id, message);
		} catch (err) {
			setChatHistory((prev) => [
				...prev,
				{
					role: "system",
					text: `Error: ${err instanceof Error ? err.message : "Failed to send"}`,
					timestamp: Date.now(),
				},
			]);
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="chat-container">
			<ChatMessageList messages={displayMessages} />
			<ChatInputRow
				value={input}
				sending={sending}
				onChange={setInput}
				onSend={handleSend}
			/>
		</div>
	);
}
