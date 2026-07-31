export interface GeoQualityScore {
  semantic_density: number;
  structural_compliance: number;
  citability: number;
  authority_signals: number;
  readability: number;
  robustness: number;
  novelty: number;
  cross_domain_contribution: number;
  overall: number;
  publish_gate_passed: boolean;
  word_count: number;
  heading_count: number;
  has_definition_block: boolean;
  data_point_count: number;
  has_comparison_block: boolean;
}

export function scoreGeoContent(input: { markdown_content: string; title: string }): GeoQualityScore {
  const { markdown_content } = input;

  const word_count = markdown_content.trim() ? markdown_content.trim().split(/\s+/).length : 0;
  const heading_count = (markdown_content.match(/^#+\s/gm) || []).length;
  const has_definition_block = /\*\*definition\*\*|\*\*定义\*\*|是指|is defined as|refers to/i.test(markdown_content);
  const data_point_count = (markdown_content.match(/\d+(\.\d+)?(%|x|倍)|\b\d{2,}\b/g) || []).length;
  const has_comparison_block = /\|---/.test(markdown_content) || /对比|vs\.?|比较/i.test(markdown_content);

  const semantic_density = Math.min(word_count / 1943, 1);
  const structural_compliance = Math.min(heading_count / 10.59, 1);
  const citability = has_definition_block
    ? 0.7 + Math.min(data_point_count * 0.1, 0.3)
    : Math.min(data_point_count * 0.15, 0.6);
  const authority_signals = has_comparison_block ? 0.7 : 0.4;
  const readability = word_count >= 1000 ? 0.75 : Math.min((word_count / 1000) * 0.75, 0.75);
  const robustness = has_definition_block && has_comparison_block ? 0.8 : 0.5;
  const novelty = (has_comparison_block ? 0.4 : 0) + (has_definition_block ? 0.3 : 0) + Math.min(data_point_count * 0.05, 0.3);
  const cross_domain_contribution = Math.min((has_definition_block ? 0.3 : 0) + data_point_count * 0.1, 0.8);

  const overall = (semantic_density + structural_compliance + citability + authority_signals + readability + robustness + novelty + cross_domain_contribution) / 8;

  const publish_gate_passed = overall >= 0.7 && word_count >= 1000 && heading_count >= 6 && has_definition_block && data_point_count >= 2 && has_comparison_block;

  return {
    semantic_density,
    structural_compliance,
    citability,
    authority_signals,
    readability,
    robustness,
    novelty,
    cross_domain_contribution,
    overall,
    publish_gate_passed,
    word_count,
    heading_count,
    has_definition_block,
    data_point_count,
    has_comparison_block,
  };
}
