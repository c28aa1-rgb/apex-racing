import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { CARS, LIVERY_IDS, carById, lookOf, withLivery } from '../shared/cars';

test('liveries change only how a car looks, never how it drives', () => {
  const formula = carById('red-bull-rb19');
  assert.deepEqual(formula.liveries?.map(livery => livery.id), [...LIVERY_IDS]);
  for (const livery of formula.liveries!) {
    const dressed = withLivery(formula, livery.id);
    assert.equal(dressed.id, formula.id);
    assert.equal(lookOf(dressed), livery.id);
    assert.equal(dressed.model, livery.model);
    assert.deepEqual([dressed.physics, dressed.dimensions, dressed.stats], [formula.physics, formula.dimensions, formula.stats]);
  }
  // A stale or missing choice falls back to the default livery; cars without liveries are untouched.
  assert.equal(lookOf(withLivery(formula, 'retired-livery')), 'red-bull-rb19');
  assert.equal(lookOf(withLivery(formula)), 'red-bull-rb19');
  assert.equal(withLivery(carById('celica-gt4'), 'mercedes-w14'), carById('celica-gt4'));
});

test('every car and livery ships a runtime model', () => {
  // Source GLBs stay local (.gitignore); the game loads these copies (design/build-car-runtime.ts).
  for (const model of CARS.flatMap(car => [car.model, ...(car.liveries ?? []).map(livery => livery.model)]))
    assert.ok(existsSync(`public/models/cars/runtime/${model}`), `${model} has no runtime copy`);
});
