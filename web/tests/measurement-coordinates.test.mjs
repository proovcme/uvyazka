import test from 'node:test';
import assert from 'node:assert/strict';
import {pagePoint,imagePoint,parsePoints} from '../../src/uvyazka/ui/measurement-coordinates.js';

test('cropped raster origin and CSS zoom map clicks into the same PDF points',()=>{
  const metadata={pixel_origin_page_points:[10.5,20.5],pixels_per_point:2,pixel_size:[1000,600]};
  for(const zoom of [.5,1,3]){
    const rect={left:40,top:70,width:1000*zoom,height:600*zoom};
    const p=pagePoint(40+200*zoom,70+100*zoom,rect,metadata);
    assert.deepEqual(p,[110.5,70.5]);
    assert.deepEqual(imagePoint(p,metadata),[200,100]);
  }
});
test('explicit coordinate input rejects missing, nonfinite and excessive points',()=>{
  assert.deepEqual(parsePoints('30, 60\n130; 60\n130 160'),[[30,60],[130,60],[130,160]]);
  for(const value of ['30','1 2 3','NaN, 0','Infinity, 1',Array(501).fill('0, 1').join('\n')]){
    assert.throws(()=>parsePoints(value));
  }
});
