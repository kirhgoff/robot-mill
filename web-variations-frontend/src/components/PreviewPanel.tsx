import { useCallback, useEffect, useRef, useState } from "react";
import type { Variation } from "../api/client";
import { EmptyState } from "./ui/EmptyState";

interface Props {
	variation: Variation;
}

type PreviewStatus = "checking" | "online" | "offline";

export function PreviewPanel({ variation }: Props) {
	const [previewStatus, setPreviewStatus] = useState<PreviewStatus>("checking");
	const [frameKey, setFrameKey] = useState(0);
	const [showFrame, setShowFrame] = useState(false);
	const wasReachableRef = useRef(false);
	const previewUrl = variation.port
		? `${window.location.protocol}//${window.location.hostname}:${variation.port}`
		: null;

	const checkPreview = useCallback(async () => {
		if (variation.status !== "running" || !previewUrl) {
			wasReachableRef.current = false;
			setPreviewStatus("checking");
			setShowFrame(false);
			return;
		}

		const controller = new AbortController();
		const timeoutId = window.setTimeout(() => controller.abort(), 2500);

		try {
			await fetch(previewUrl, {
				method: "GET",
				mode: "no-cors",
				cache: "no-store",
				signal: controller.signal,
			});
			if (!wasReachableRef.current) {
				setFrameKey((current) => current + 1);
			}
			wasReachableRef.current = true;
			setPreviewStatus("online");
			setShowFrame(true);
		} catch {
			wasReachableRef.current = false;
			setPreviewStatus("offline");
			setShowFrame(false);
		} finally {
			window.clearTimeout(timeoutId);
		}
	}, [previewUrl, variation.status]);

	useEffect(() => {
		wasReachableRef.current = false;
		setPreviewStatus("checking");
		setShowFrame(false);
		void checkPreview();
	}, [checkPreview, variation.id, variation.port, variation.status]);

	useEffect(() => {
		if (variation.status !== "running" || !previewUrl) return;
		const intervalId = window.setInterval(() => {
			void checkPreview();
		}, 3000);
		return () => window.clearInterval(intervalId);
	}, [checkPreview, previewUrl, variation.status]);

	if (variation.status !== "running" || !previewUrl) {
		return (
			<EmptyState
				icon="🖥"
				title="Server is not running"
				subtitle="Start the server to see the preview"
			/>
		);
	}

	if (!showFrame) {
		return (
			<div className="preview-status-panel">
				<div className="preview-status-title">
					{previewStatus === "checking"
						? "Checking preview availability…"
						: "Preview is temporarily unavailable"}
				</div>
				<div className="preview-status-subtitle">
					{previewStatus === "checking"
						? `Trying to connect to ${previewUrl}`
						: "The panel will keep watching and automatically reload the site when it comes back."}
				</div>
				<button className="btn" onClick={() => void checkPreview()}>
					Retry now
				</button>
			</div>
		);
	}

	return (
		<iframe
			key={frameKey}
			className="preview-frame"
			src={previewUrl}
			title={`Preview: ${variation.title}`}
			onLoad={() => {
				wasReachableRef.current = true;
				setPreviewStatus("online");
			}}
		/>
	);
}
