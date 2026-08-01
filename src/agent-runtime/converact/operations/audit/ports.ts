import type {
  ConveractFabricAuditAppendInput,
  ConveractFabricAuditAppendResult,
  ConveractFabricAuditListInput,
  ConveractFabricAuditPage
} from './types.js';

export interface ConveractFabricAuditRepository {
  append(input: ConveractFabricAuditAppendInput): Promise<ConveractFabricAuditAppendResult>;
  list(input: ConveractFabricAuditListInput): Promise<ConveractFabricAuditPage>;
}
