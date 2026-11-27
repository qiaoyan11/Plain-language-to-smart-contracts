import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, reconnectDelay } from "@/api/client";

export function useActiveDraft() {
  const [id, setId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setId(api.getActiveDraftId());
  }, []);
  const query = useQuery({
    queryKey: ["draft", id],
    queryFn: () => api.getDraft(id!),
    enabled: Boolean(id),
    retry: false,
    refetchOnReconnect: "always",
    refetchInterval: (current) => reconnectDelay(current.state.error) || (current.state.data?.busy ? 1500 : false),
  });
  function selectDraft(nextId: string | null) {
    api.setActiveDraftId(nextId);
    setId(nextId);
  }
  return { id, selectDraft, query, session: query.data };
}
