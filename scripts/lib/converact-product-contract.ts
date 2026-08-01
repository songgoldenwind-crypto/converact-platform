export const CONVERACT_FABRIC_PRODUCT = 'Converact Fabric' as const;
export const CONVERACT_FABRIC_STANDALONE_PRODUCT =
  'Converact Fabric standalone service' as const;

/**
 * Exact legacy wire identifiers accepted while pre-rename artifacts remain in
 * their documented compatibility window. New artifacts must never emit them.
 * Remove this read compatibility at the Converact Platform 1.0.0 boundary.
 */
const LEGACY_CONVERACT_FABRIC_PRODUCT = 'iveKit' as const;
const LEGACY_CONVERACT_FABRIC_STANDALONE_PRODUCT = 'iveKit standalone service' as const;

export const LEGACY_FABRIC_PRODUCT_REMOVAL_VERSION =
  'Converact Platform 1.0.0' as const;

export type FabricProductContractId =
  | typeof CONVERACT_FABRIC_PRODUCT
  | typeof LEGACY_CONVERACT_FABRIC_PRODUCT;

export type FabricStandaloneProductContractId =
  | typeof CONVERACT_FABRIC_STANDALONE_PRODUCT
  | typeof LEGACY_CONVERACT_FABRIC_STANDALONE_PRODUCT;

export function acceptFabricProduct(value: unknown): FabricProductContractId {
  if (value === CONVERACT_FABRIC_PRODUCT || value === LEGACY_CONVERACT_FABRIC_PRODUCT) {
    return value;
  }
  throw new Error('invalid Converact Fabric product identifier');
}

export function acceptFabricStandaloneProduct(
  value: unknown
): FabricStandaloneProductContractId {
  if (
    value === CONVERACT_FABRIC_STANDALONE_PRODUCT ||
    value === LEGACY_CONVERACT_FABRIC_STANDALONE_PRODUCT
  ) {
    return value;
  }
  throw new Error('invalid Converact Fabric standalone product identifier');
}

export function isAcceptedFabricProduct(
  value: unknown
): value is FabricProductContractId {
  try {
    acceptFabricProduct(value);
    return true;
  } catch {
    return false;
  }
}

export function isAcceptedFabricStandaloneProduct(
  value: unknown
): value is FabricStandaloneProductContractId {
  try {
    acceptFabricStandaloneProduct(value);
    return true;
  } catch {
    return false;
  }
}
