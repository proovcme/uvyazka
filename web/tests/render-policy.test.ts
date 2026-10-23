import test from 'node:test';
import assert from 'node:assert/strict';
import {renderPolicy} from '../src/render-policy.ts';
test('large models bound GPU quality without changing the element set',()=>{
  assert.deepEqual(renderPolicy(2620,2),{shadows:false,pixelRatio:1.25,edgeBudget:100000});
  assert.deepEqual(renderPolicy(22,3),{shadows:true,pixelRatio:2,edgeBudget:600000});
  assert.equal(renderPolicy(9000,1).pixelRatio,1);
});
