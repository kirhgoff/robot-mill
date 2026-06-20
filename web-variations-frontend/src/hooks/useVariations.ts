import { useState, useEffect, useCallback } from "react";
import { api, type Variation } from "../api/client";

export function useVariations(pollInterval = 3000) {
	const [variations, setVariations] = useState<Variation[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const data = await api.listVariations();
			setVariations(data);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to fetch");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
		const interval = setInterval(refresh, pollInterval);
		return () => clearInterval(interval);
	}, [refresh, pollInterval]);

	return { variations, loading, error, refresh };
}
