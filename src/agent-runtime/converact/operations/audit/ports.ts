import type {
  IveKitAuditAppendInput,
  IveKitAuditAppendResult,
  IveKitAuditListInput,
  IveKitAuditPage
} from './types.js';

export interface IveKitAuditRepository {
  append(input: IveKitAuditAppendInput): Promise<IveKitAuditAppendResult>;
  list(input: IveKitAuditListInput): Promise<IveKitAuditPage>;
}
