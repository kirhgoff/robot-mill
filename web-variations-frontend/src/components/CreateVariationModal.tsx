import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../api/client";
import { Modal } from "./ui/Modal";
import { FormField } from "./ui/FormField";
import { ModalActions } from "./ui/ModalActions";

interface Props {
	onClose: () => void;
	onCreated: () => void;
}

const DEFAULT_PROMPT = "Do not do any changes";

export function CreateVariationModal({ onClose, onCreated }: Props) {
	const [title, setTitle] = useState("");
	const [prompt, setPrompt] = useState("");
	const [baseBranch, setBaseBranch] = useState<string>("");
	const [branches, setBranches] = useState<string[]>([]);
	const [branchesLoading, setBranchesLoading] = useState(true);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadBranches = useCallback(async () => {
		setBranchesLoading(true);
		setError(null);
		await api.refreshSource();
		const res = await api.listBranches();
		setBranches(res.branches);
		setBaseBranch((current) => {
			if (current && res.branches.includes(current)) return current;
			return (
				res.branches.find((branch) => branch === "main") ??
				res.branches.find((branch) => branch === "master") ??
				res.branches[0] ??
				current
			);
		});
		setBranchesLoading(false);
	}, []);

	// Fetch latest from origin, then load the branch list so the user can pick
	// a base branch. This guarantees newly pushed branches show up.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				await loadBranches();
			} catch (err) {
				if (cancelled) return;
				setError(
					err instanceof Error
						? `Failed to load branches: ${err.message}`
						: "Failed to load branches",
				);
				setBranchesLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [loadBranches]);

	const resolvedBaseBranch = baseBranch.trim();
	const resolvedTitle = title.trim() || resolvedBaseBranch;
	const resolvedPrompt = prompt.trim() || DEFAULT_PROMPT;
	const canCreate = useMemo(
		() => !branchesLoading && Boolean(resolvedTitle),
		[branchesLoading, resolvedTitle],
	);

	const handleSubmit = async () => {
		if (!canCreate) return;
		setSubmitting(true);
		setError(null);
		try {
			// Always refresh immediately before creating so the new worktree is
			// based on the latest commits from origin.
			await api.refreshSource();
			await api.createVariation({
				title: resolvedTitle,
				prompt: resolvedPrompt,
				baseBranch: resolvedBaseBranch || undefined,
			});
			onCreated();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Modal title="Create New Variation" onClose={onClose}>
			<FormField label="Title">
				<input
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Defaults to selected branch"
					autoFocus
				/>
			</FormField>
			<FormField label="Base branch">
				{branchesLoading ? (
					<div style={{ fontSize: 13, color: "var(--text-muted)" }}>
						Loading branches…
					</div>
				) : branches.length > 0 ? (
					<select
						value={baseBranch}
						onChange={(e) => setBaseBranch(e.target.value)}
					>
						{branches.map((branch) => (
							<option key={branch} value={branch}>
								{branch}
							</option>
						))}
					</select>
				) : (
					<input
						type="text"
						value={baseBranch}
						onChange={(e) => setBaseBranch(e.target.value)}
						placeholder="main"
					/>
				)}
			</FormField>
			<FormField label="Prompt">
				<textarea
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder={`Optional — defaults to "${DEFAULT_PROMPT}"`}
				/>
			</FormField>
			{error && (
				<div style={{ color: "var(--red)", fontSize: 13, marginBottom: 12 }}>
					<div>{error}</div>
					{!submitting && (
						<button
							type="button"
							className="btn btn-sm"
							onClick={() => {
								loadBranches().catch((err) => {
									setError(
										err instanceof Error
											? `Failed to load branches: ${err.message}`
											: "Failed to load branches",
									);
									setBranchesLoading(false);
								});
							}}
							style={{ marginTop: 8 }}
						>
							Retry branch fetch
						</button>
					)}
				</div>
			)}
			<ModalActions>
				<button className="btn" onClick={onClose} disabled={submitting}>
					Cancel
				</button>
				<button
					className="btn btn-primary"
					onClick={handleSubmit}
					disabled={submitting || !canCreate}
				>
					{submitting ? "Creating..." : "Create"}
				</button>
			</ModalActions>
		</Modal>
	);
}
