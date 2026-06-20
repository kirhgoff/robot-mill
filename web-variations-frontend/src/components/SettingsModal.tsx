import { useState, useEffect } from "react";
import { api, type TargetProjectConfig } from "../api/client";
import { Modal } from "./ui/Modal";
import { FormField } from "./ui/FormField";
import { ModalActions } from "./ui/ModalActions";

interface Props {
	onClose: () => void;
}

function InfoValue({ value, mono }: { value: string; mono?: boolean }) {
	return (
		<div
			style={{
				fontSize: 13,
				color: "var(--text-secondary)",
				...(mono ? { fontFamily: "var(--font-mono)" } : {}),
			}}
		>
			{value}
		</div>
	);
}

export function SettingsModal({ onClose }: Props) {
	const [config, setConfig] = useState<TargetProjectConfig | null>(null);
	const [sourceRepo, setSourceRepo] = useState("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		api.getConfig().then((cfg) => {
			setConfig(cfg);
			setSourceRepo(cfg.sourceRepo);
		});
	}, []);

	const handleSave = async () => {
		setSaving(true);
		try {
			const updated = await api.updateConfig({ sourceRepo });
			setConfig(updated);
			onClose();
		} catch {
			// ignore
		} finally {
			setSaving(false);
		}
	};

	if (!config) return null;

	return (
		<Modal title="Settings" onClose={onClose}>
			<FormField label="Source Repository">
				<input
					type="text"
					value={sourceRepo}
					onChange={(e) => setSourceRepo(e.target.value)}
					placeholder="https://github.com/user/repo.git"
				/>
			</FormField>
			<FormField label="Port Range">
				<InfoValue value={`${config.portRangeMin} – ${config.portRangeMax}`} />
			</FormField>
			<FormField label="Data Directory">
				<InfoValue value={config.dataDir} mono />
			</FormField>
			<ModalActions>
				<button className="btn" onClick={onClose}>
					Cancel
				</button>
				<button
					className="btn btn-primary"
					onClick={handleSave}
					disabled={saving}
				>
					{saving ? "Saving..." : "Save"}
				</button>
			</ModalActions>
		</Modal>
	);
}
