export interface BrandEntity {
  id: string;
  tenant_id: string;
  workspace_id: string;
  entity_type: 'brand' | 'product' | 'service' | 'team' | 'credential' | 'pricing' | 'channel';
  entity_name: string;
  entity_description?: string;
  entity_metadata: Record<string, unknown>;
  source_url?: string;
  verified: boolean;
  created_at: string;
  updated_at: string;
}

export interface BrandFactCard {
  id: string;
  tenant_id: string;
  workspace_id: string;
  fact_type: 'definition' | 'data_point' | 'comparison' | 'how_to' | 'case_result' | 'credential';
  fact_content: string;
  fact_evidence?: string;
  source_url?: string;
  citability_score: number;
  verified: boolean;
  entity_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface BrandCase {
  id: string;
  tenant_id: string;
  workspace_id: string;
  case_title: string;
  customer_profile?: string;
  problem_description?: string;
  solution_description?: string;
  outcome_metrics: Record<string, unknown>;
  outcome_quote?: string;
  source_url?: string;
  created_at: string;
}

export interface BrandFaqEntry {
  id: string;
  tenant_id: string;
  workspace_id: string;
  question: string;
  answer: string;
  objection_type: 'price' | 'trust' | 'competitor' | 'timing' | 'need' | 'other';
  call_outcome_source_id?: string;
  times_asked: number;
  created_at: string;
  updated_at: string;
}

export interface BrandKbCompleteness {
  id: string;
  tenant_id: string;
  workspace_id: string;
  entity_score: number;
  fact_card_score: number;
  case_score: number;
  faq_score: number;
  overall_score: number;
  missing_items: string[];
  last_scored_at?: string;
}

export interface ScriptKbContext {
  key_facts: { fact_type: string; fact_content: string; fact_evidence?: string }[];
  top_cases: { case_title: string; outcome_quote?: string; outcome_metrics: Record<string, unknown> }[];
  faq_answers: { question: string; answer: string; objection_type: string }[];
  kb_completeness_score: number;
}
