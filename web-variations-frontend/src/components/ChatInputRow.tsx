interface Props {
	value: string;
	sending: boolean;
	onChange: (value: string) => void;
	onSend: () => void;
}

export function ChatInputRow({ value, sending, onChange, onSend }: Props) {
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			onSend();
		}
	};

	return (
		<div className="chat-input-row">
			<textarea
				className="chat-input"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
				rows={2}
			/>
			<button
				className="btn btn-primary"
				onClick={onSend}
				disabled={sending || !value.trim()}
			>
				{sending ? "..." : "Send"}
			</button>
		</div>
	);
}
