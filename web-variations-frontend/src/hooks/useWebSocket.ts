import { useState, useEffect, useRef, useCallback } from "react";

export interface AgentOutput {
	type: string;
	agentId: string;
	timestamp: number;
	data: unknown;
}

export function useWebSocket(agentId: string | null) {
	const [messages, setMessages] = useState<AgentOutput[]>([]);
	const [connected, setConnected] = useState(false);
	const wsRef = useRef<WebSocket | null>(null);

	useEffect(() => {
		if (!agentId) return;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
		wsRef.current = ws;

		ws.onopen = () => {
			setConnected(true);
			ws.send(JSON.stringify({ action: "subscribe", agentId }));
		};

		ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as AgentOutput;
				if (data.agentId === agentId) {
					setMessages((prev) => [...prev, data]);
				}
			} catch {
				// ignore
			}
		};

		ws.onclose = () => {
			setConnected(false);
		};

		return () => {
			ws.close();
			wsRef.current = null;
		};
	}, [agentId]);

	const clearMessages = useCallback(() => setMessages([]), []);

	return { messages, connected, clearMessages };
}
