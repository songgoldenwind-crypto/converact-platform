import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERACT_FABRIC_PRODUCT,
  CONVERACT_FABRIC_STANDALONE_PRODUCT,
  LEGACY_FABRIC_PRODUCT_REMOVAL_VERSION,
  acceptFabricProduct,
  acceptFabricStandaloneProduct
} from '../scripts/lib/converact-product-contract.js';

test('new Converact machine contracts are canonical and the legacy window is explicit', () => {
  assert.equal(CONVERACT_FABRIC_PRODUCT, 'Converact Fabric');
  assert.equal(
    CONVERACT_FABRIC_STANDALONE_PRODUCT,
    'Converact Fabric standalone service'
  );
  assert.equal(LEGACY_FABRIC_PRODUCT_REMOVAL_VERSION, 'Converact Platform 1.0.0');
});

test('machine contract readers accept only the canonical or exact legacy product identifiers', () => {
  assert.equal(acceptFabricProduct('Converact Fabric'), 'Converact Fabric');
  assert.equal(acceptFabricProduct('iveKit'), 'iveKit');
  assert.equal(
    acceptFabricStandaloneProduct('Converact Fabric standalone service'),
    'Converact Fabric standalone service'
  );
  assert.equal(
    acceptFabricStandaloneProduct('iveKit standalone service'),
    'iveKit standalone service'
  );

  for (const invalid of [undefined, null, '', 'OPC', 'ivekit', 'Converact', 'Converact Fabric ']) {
    assert.throws(() => acceptFabricProduct(invalid), /invalid Converact Fabric product identifier/);
  }
  for (const invalid of [undefined, null, '', 'iveKit service', 'Converact Fabric']) {
    assert.throws(
      () => acceptFabricStandaloneProduct(invalid),
      /invalid Converact Fabric standalone product identifier/
    );
  }
});
