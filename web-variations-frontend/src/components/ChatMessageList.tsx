import { useRef, useEffect } from "react";

export interface ChatMessage {
	role: "user" | "assistant" | "system";
	text: string;
	timestamp: number;
}

interface Props {
	messages: ChatMessage[];
}

function MessageContent({ message }: { message: ChatMessage }) {
	if (message.role === "system") {
		return (
			<span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
				{message.text}
			</span>
		);
	}
	return (
		<pre
			style={{
				whiteSpace: "pre-wrap",
				wordBreak: "break-word",
				fontFamily: "var(--font-sans)",
				margin: 0,
				background: "transparent",
				padding: 0,
				fontSize: "inherit",
			}}
		>
			{message.text}
		</pre>
	);
}

export function ChatMessageList({ messages }: Props) {
	const endRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		endRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	return (
		<div className="chat-messages">
			{messages.map((msg, i) => (
				<div key={i} className={`chat-message ${msg.role}`}>
					<MessageContent message={msg} />
				</div>
			))}
			<div ref={endRef} />
		</div>
	);
}
