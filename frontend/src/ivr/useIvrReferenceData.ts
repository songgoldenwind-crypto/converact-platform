import { useEffect, useState } from 'react';

export function useIvrReferenceData() {
  const [flows, setFlows] = useState<Array<{ id: string; name: string }>>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<Array<{ id: string; name: string }>>([]);
  const [groupCallGroups, setGroupCallGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [regionGroups, setRegionGroups] = useState<Array<{ id: string; name: string }>>([]);
  const [seats, setSeats] = useState<Array<{ id: string; display_name: string }>>([]);

  const [queues, setQueues] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    void Promise.all([
      fetch('/api/ivr/flows').then((r) => r.json()).then((j) => setFlows((j.data || j || []).map((f: { id: string; name: string }) => ({ id: f.id, name: f.name })))),
      fetch('/api/knowledge/bases').then((r) => r.json()).then((j) => setKnowledgeBases(j.data || j || [])),
      fetch('/api/ivr/settings/group-call-groups').then((r) => r.json()).then((j) => setGroupCallGroups(j.data || [])),
      fetch('/api/ivr/settings/region-groups').then((r) => r.json()).then((j) => setRegionGroups(j.data || [])),
      fetch('/api/call-center/queues').then((r) => r.json()).then((j) => {
        const list = j.data || j || [];
        setQueues(list.map((q: { id: string; name: string }) => ({ id: q.id, name: q.name })));
      }).catch(() => setQueues([])),
      fetch('/api/call-center/seats').then((r) => r.json()).then((j) => {
        const list = j.data || j || [];
        setSeats(list.map((s: { id: string; display_name?: string }) => ({ id: s.id, display_name: s.display_name || s.id })));
      }).catch(() => setSeats([])),
    ]);
  }, []);

  return { flows, knowledgeBases, groupCallGroups, regionGroups, seats, queues };
}
