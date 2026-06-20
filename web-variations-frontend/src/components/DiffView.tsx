import { useState, useEffect } from "react";
import { api, type VariationDiff, type DiffFile } from "../api/client";
import { EmptyState } from "./ui/EmptyState";
import { DiffSummary } from "./DiffSummary";

interface Props {
	variationId: string;
}

function DiffLine({ line }: { line: string }) {
	let cls = "diff-line";
	if (line.startsWith("+") && !line.startsWith("+++")) cls += " added";
	else if (line.startsWith("-") && !line.startsWith("---")) cls += " removed";
	return <div className={cls}>{line}</div>;
}

function DiffFileView({ file }: { file: DiffFile }) {
	const [expanded, setExpanded] = useState(true);

	return (
		<div className="diff-file">
			<div
				className="diff-file-header"
				onClick={() => setExpanded(!expanded)}
				style={{ cursor: "pointer" }}
			>
				<span>
					{file.status === "added" && "➕ "}
					{file.status === "deleted" && "➖ "}
					{file.status === "modified" && "✏️ "}
					{file.status === "renamed" && "📝 "}
					{file.path}
				</span>
				<span style={{ color: "var(--text-muted)" }}>
					<span style={{ color: "var(--green)" }}>+{file.additions}</span>{" "}
					<span style={{ color: "var(--red)" }}>-{file.deletions}</span>
				</span>
			</div>
			{expanded && (
				<div className="diff-content">
					{file.patch.split("\n").map((line, i) => (
						<DiffLine key={i} line={line} />
					))}
				</div>
			)}
		</div>
	);
}

export function DiffView({ variationId }: Props) {
	const [diff, setDiff] = useState<VariationDiff | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setLoading(true);
		api
			.getDiff(variationId)
			.then(setDiff)
			.catch((err) => setError(err instanceof Error ? err.message : "Failed"))
			.finally(() => setLoading(false));
	}, [variationId]);

	if (loading) return <EmptyState title="Loading diff..." />;
	if (error) return <EmptyState title={error} />;
	if (!diff || diff.files.length === 0) return <EmptyState title="No changes yet" />;

	return (
		<div className="diff-container">
			<DiffSummary summary={diff.summary} />
			{diff.files.map((file) => (
				<DiffFileView key={file.path} file={file} />
			))}
		</div>
	);
}
