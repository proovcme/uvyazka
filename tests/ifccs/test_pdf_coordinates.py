"""PDF geometry seen in real CAD exports must survive the MCP JSON boundary."""
import json
import pymupdf
from uvyazka.construction.drawings import pdf_coordinates, inspect_source


def test_nested_quadrilateral_keeps_all_four_points():
    quad = pymupdf.Rect(1, 2, 7, 9).quad
    result = pdf_coordinates(('qu', quad))
    assert json.loads(json.dumps(result)) == ['qu', [[1.,2.],[7.,2.],[1.,9.],[7.,9.]]]


def test_pdf_spans_preserve_individual_label_positions(workspace_temp):
    path = workspace_temp / 'labels.pdf'
    doc=pymupdf.open();page=doc.new_page()
    page.insert_text((30,50),'GRID A');page.insert_text((130,50),'GRID B')
    page.draw_quad(pymupdf.Rect(30,70,70,100).quad)
    doc.save(path);doc.close()
    info=inspect_source(path,limit=1000)
    json.dumps(info,allow_nan=False)
    spans=info['text_spans']
    assert [s['text'] for s in spans] == ['GRID A','GRID B']
    assert spans[0]['region'][0] < spans[1]['region'][0]
    assert info['text_span_total'] == 2
