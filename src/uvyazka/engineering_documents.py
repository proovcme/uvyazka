"""Local calculation reports, bounded vector sheets and explicit PDF checks.

Layout templates are working documents, not a blanket SPDS certification.
Checks inspect actual PDF bytes against the caller's applicable criteria.
"""
import json
import math
from pathlib import Path
from uuid import uuid4

from .core import digest, encode
from .document_tables import bounded, fingerprint, number
from .engineering_work import EngineeringWork, identifier
from .engineering_calculations import LABELS, METHODS

MM=72/25.4
FORMATS={'A4':(210,297),'A3':(420,297)}
LAYOUT='engineering-review-layout-v1'


def schema():
    return {'layout_revision':LAYOUT,'formats':FORMATS,
        'metadata':'designation, project, stage, organization: nonempty text. Optional developer/checker names; signatures are never generated.',
        'calculations':'Up to 20 {calculation_id,revision}; exact stored cases become a paginated calculation report.',
        'pages':'Up to 30 {format:A4|A3,title,entities:[...]}; each entity is one of the contracts below.',
        'entities':{
            'line':{'type':'line','points_mm':[[30,30],[80,30]],'width_mm':0.25},
            'rectangle':{'type':'rectangle','rect_mm':[30,35,80,55],'width_mm':0.25},
            'circle':{'type':'circle','center_mm':[90,45],'radius_mm':4,'width_mm':0.25},
            'text':{'type':'text','rect_mm':[30,60,100,75],'text':'Synthetic label','font_size_pt':9},
            'symbol':{'type':'symbol','symbol_id':'project-device','origin_mm':[40,90],'scale':1}},
        'symbols':'Up to 100 {id,label,basis,entities}; local line/rectangle/circle/text commands only, no nesting. basis identifies a verified standard symbol or an explicitly project-defined symbol. Used symbols receive a legend on the same sheet.',
        'layout':'Frame margins 20/5/5/5 mm; first title region 185×55 mm, subsequent 185×15 mm. This template needs applicable form, font and correction review before issue.',
        'checks':{
            'page_size':'width_mm,height_mm,tolerance_mm,basis',
            'frame':'left_mm,right_mm,top_mm,bottom_mm,tolerance_mm,basis; native vector rectangle/edges',
            'minimum_font_size':'minimum_pt,basis; PDF em size, not measured cap height; optional region_mm',
            'required_text':'text,basis; optional region_mm in unrotated PDF mm'},
        'limits':'No arbitrary executable code, original edits, forged signatures or automatic statutory approval. Unknown check kinds remain unchecked.'}


def finite(value,lower=None,upper=None):
    if type(value) not in (int,float) or not math.isfinite(value):raise ValueError('Finite drawing number required')
    if lower is not None and value<lower or upper is not None and value>upper:raise ValueError('Drawing number outside bounds')
    return float(value)


def text(value,maximum=4000):
    if not isinstance(value,str) or not value.strip() or len(value)>maximum:
        raise ValueError('Nonempty bounded text required')
    if any(ord(c)<32 and c not in '\n\t' for c in value):raise ValueError('Unsupported control character')
    return value


def rectangle(value):
    if not isinstance(value,list) or len(value)!=4:raise ValueError('Four rectangle coordinates required')
    x0,y0,x1,y1=[finite(x) for x in value]
    if x1<=x0 or y1<=y0:raise ValueError('Rectangle must have positive area')
    return [x0,y0,x1,y1]


def inspect_pdf(pdf,pages,requirements):
    import pymupdf as fitz
    if (not isinstance(pages,list) or not 1<=len(pages)<=10
            or any(type(p) is not int or not 1<=p<=len(pdf) for p in pages)
            or len(set(pages))!=len(pages)):
        raise ValueError('Choose 1–10 distinct physical PDF pages')
    if not isinstance(requirements,list) or not 1<=len(requirements)<=40:
        raise ValueError('Provide 1–40 applicable PDF requirements')
    for req in requirements:
        if not isinstance(req,dict):raise ValueError('Requirement must be an object')
        text(req.get('basis'),2000)
    results=[]
    for index in pages:
        page=pdf[index-1]
        # Work in native, unrotated coordinates, consistent with source locators.
        rotation=page.rotation;page.set_rotation(0)
        width,height=page.rect.width/MM,page.rect.height/MM
        drawings=None
        for ordinal,req in enumerate(requirements,1):
            kind=req.get('kind');status='unchecked';actual=None;note=''
            if kind=='page_size':
                expected=[finite(req['width_mm'],1,5000),finite(req['height_mm'],1,5000)]
                tolerance=finite(req['tolerance_mm'],0,5)
                actual=[width,height];status='met' if all(abs(a-b)<=tolerance for a,b in zip(actual,expected)) else 'not_met'
            elif kind=='frame':
                margins=[finite(req[k],0,100) for k in ('left_mm','top_mm','right_mm','bottom_mm')]
                tolerance=finite(req['tolerance_mm'],0,5)*MM
                target=fitz.Rect(margins[0]*MM,margins[1]*MM,page.rect.width-margins[2]*MM,page.rect.height-margins[3]*MM)
                if target.is_empty:raise ValueError('Frame margins leave no drawing area')
                if drawings is None:drawings=page.get_drawings()
                if len(drawings)>20000:
                    note='Vector budget exceeded; frame was not checked'
                elif not drawings:
                    note='No native vectors; raster frame requires visual/OCR-assisted review'
                else:
                    edges=[];rectangles=[]
                    for path in drawings:
                        if path.get('type') not in {'s','fs'}:continue
                        for item in path['items']:
                            if item[0]=='re':rectangles.append(item[1])
                            elif item[0]=='l':edges.append((item[1],item[2]))
                    found=any(max(abs(a-b) for a,b in zip(r,target))<=tolerance for r in rectangles)
                    wanted=[(target.tl,target.tr),(target.tr,target.br),(target.bl,target.br),(target.tl,target.bl)]
                    def covered(start,end):
                        horizontal=abs(start.y-end.y)<=tolerance
                        intervals=[]
                        for a,b in edges:
                            if horizontal and max(abs(a.y-start.y),abs(b.y-start.y))<=tolerance:
                                intervals.append(sorted([a.x,b.x]))
                            elif not horizontal and max(abs(a.x-start.x),abs(b.x-start.x))<=tolerance:
                                intervals.append(sorted([a.y,b.y]))
                        lo,hi=(start.x,end.x) if horizontal else (start.y,end.y)
                        cursor=lo
                        for left,right in sorted(intervals):
                            if right<cursor-tolerance:continue
                            if left>cursor+tolerance:return False
                            cursor=max(cursor,right)
                            if cursor>=hi-tolerance:return True
                        return False
                    sides=[covered(a,b) for a,b in wanted]
                    actual={'rectangle_found':found,'covered_edges':sides}
                    status='met' if found or all(sides) else 'not_met'
            elif kind in {'minimum_font_size','required_text'}:
                clip=fitz.Rect([x*MM for x in rectangle(req['region_mm'])]) if 'region_mm' in req else page.rect
                if not page.rect.contains(clip):raise ValueError('Text inspection region outside page')
                if kind=='required_text':
                    expected=' '.join(text(req.get('text')).split())
                    native=' '.join(page.get_text(clip=clip).split())
                    if native:
                        actual={'found':expected in native};status='met' if actual['found'] else 'not_met'
                    else:note='No native text in region; not evidence that the printed field is absent'
                else:
                    minimum=finite(req['minimum_pt'],1,100)
                    sizes=[span['size'] for block in page.get_text('dict',clip=clip)['blocks'] if 'lines' in block
                           for line in block['lines'] for span in line['spans'] if span['text'].strip()]
                    if sizes:
                        actual={'minimum_pt':min(sizes),'span_count':len(sizes)}
                        status='met' if min(sizes)+1e-4>=minimum else 'not_met'
                    else:note='No native text; font em size unavailable'
            else:note='Unsupported check kind; geometry, UGO semantics and applicability are not guessed'
            results.append({'page_number':index,'requirement_number':ordinal,'kind':kind,'basis':req['basis'],
                            'status':status,'actual':actual,'note':note})
        page.set_rotation(rotation)
    return bounded({'page_count':len(pdf),'checked_pages':pages,'remaining_pages':len(pdf)-len(pages),
                    'checks':results,'counts':{state:sum(x['status']==state for x in results) for state in ('met','not_met','unchecked')},
                    'coordinate_system':'pdf_unrotated_top_left_mm','compliance_status':'limited_explicit_checks_only','accepted':False})


class EngineeringDocuments:
    def __init__(self,workspace,project_id):
        self.workspace,self.project_id=workspace,project_id
        self.work=EngineeringWork(workspace,project_id)

    def build(self,document_id,title,metadata,calculations,pages,symbols,basis,sources,assumptions,
              request_id,expected_revision=0,reason=''):
        import pymupdf as fitz
        identifier(document_id);text(title,300)
        fields={'designation','project','stage','organization'}
        if not isinstance(metadata,dict) or not fields<=metadata.keys() or set(metadata)-fields-{'developer','checker'}:
            raise ValueError('Provide declared title-block metadata')
        for value in metadata.values():text(value,160)
        if not isinstance(calculations,list) or len(calculations)>20 or not isinstance(pages,list) or len(pages)>30:
            raise ValueError('At most 20 calculations and 30 vector sheets')
        if not calculations and not pages:raise ValueError('Choose calculations or drawing sheets')
        if not isinstance(symbols,list) or len(symbols)>100:raise ValueError('At most 100 symbol definitions')
        definitions={}
        for symbol in symbols:
            if not isinstance(symbol,dict) or set(symbol)!={'id','label','basis','entities'}:raise ValueError('Invalid symbol definition')
            identifier(symbol['id']);text(symbol['label'],200);text(symbol['basis'],2000)
            if symbol['id'] in definitions:raise ValueError('Duplicate symbol ID')
            if not isinstance(symbol['entities'],list) or not 1<=len(symbol['entities'])<=50:raise ValueError('Bounded nonempty symbol geometry required')
            if any(not isinstance(e,dict) or e.get('type')=='symbol' for e in symbol['entities']):raise ValueError('Nested symbols unsupported')
            definitions[symbol['id']]=symbol
        case_items=[];source_links=list(sources);declared=list(assumptions)
        for ref in calculations:
            if not isinstance(ref,dict) or set(ref)!={'calculation_id','revision'}:raise ValueError('Pin calculation ID and revision')
            case=self.work.get('calculation',ref['calculation_id'],ref['revision'])['items'][0]
            if not case['current_sources'] or not case['method_current']:raise ValueError('Calculation source or method changed')
            case_items.append(case);source_links.extend(case['sources']);declared.extend(case['assumptions'])
        source_links=list({fingerprint(x):x for x in source_links}.values());declared=list(dict.fromkeys(declared))
        definition=dict(metadata=metadata,calculations=calculations,pages=pages,symbols=symbols,layout_revision=LAYOUT)
        if len(encode(definition))>160000:raise ValueError('Drawing definition exceeds 160000 characters')
        # Definition-identified artifacts are reused; final persistence checks
        # request/revision conflicts and all original source bytes.
        identity=fingerprint({'title':title,'definition':definition,'basis':basis,'sources':source_links,'assumptions':declared})
        folder=self.path_folder(document_id);folder.mkdir(parents=True,exist_ok=True)
        target=folder/(identity+'.pdf')
        if target.exists():
            manifest=folder/(identity+'.json')
            if not manifest.is_file() or json.loads(manifest.read_text(encoding='utf-8'))['sha256']!=digest(target):
                raise ValueError('Generated artifact changed; inspect it before rebuilding')
            generation=json.loads(manifest.read_text(encoding='utf-8'))
        else:
            pdf=fitz.open();font=fitz.Font('cjk');page=None;y=0;generated=[]

            def write_box(rect,value,size=8):
                remaining=page.insert_textbox(fitz.Rect([x*MM for x in rect]),value,fontname='aec',fontsize=size,lineheight=1.25)
                if remaining<-.01:raise ValueError('Text does not fit its declared rectangle; enlarge or split it')

            def start(format_name,page_title):
                nonlocal page,y
                if len(pdf)>=100:raise ValueError('Document exceeds 100 pages')
                if format_name not in FORMATS:raise ValueError('Choose A4 or A3')
                width,height=FORMATS[format_name];first=len(pdf)==0
                page=pdf.new_page(width=width*MM,height=height*MM);page.insert_font(fontname='aec',fontbuffer=font.buffer)
                frame=fitz.Rect(20*MM,5*MM,(width-5)*MM,(height-5)*MM)
                page.draw_rect(frame,width=.35*MM)
                sh=55 if first else 15;x=width-5-185;top=height-5-sh
                stamp=fitz.Rect(x*MM,top*MM,(width-5)*MM,(height-5)*MM);page.draw_rect(stamp,width=.35*MM)
                page.draw_line((x*MM,(top+10)*MM),((width-5)*MM,(top+10)*MM),width=.18*MM)
                write_box([x+2,top+1,x+145,top+9],metadata['designation'],9)
                write_box([x+148,top+1,width-7,top+9],str(len(pdf)),9)
                if first:
                    write_box([x+2,top+11,x+183,top+22],metadata['project'],8)
                    write_box([x+2,top+23,x+183,top+36],title,8)
                    write_box([x+2,top+37,x+183,top+44],metadata['organization']+' | '+metadata['stage'],8)
                    names='; '.join(label+': '+metadata[key] for key,label in [('developer','Разработал'),('checker','Проверил')] if metadata.get(key))
                    if names:write_box([x+2,top+45,x+183,top+53],names,7)
                write_box([25,8,width-10,20],page_title,10)
                generated.append({'page_number':len(pdf),'format':format_name,'title':page_title,'title_region_mm':[x,top,width-5,height-5]})
                y=23
                return width,height,top,stamp

            def paragraph(value,size=8):
                nonlocal y
                for original in value.splitlines() or ['']:
                    remaining=original
                    while remaining or original=='':
                        if page is None or y+size/MM*1.5>generated[-1]['title_region_mm'][1]-3:
                            start('A4',title+' — продолжение')
                        width=page.rect.width/MM-35;line=''
                        for char in remaining:
                            if font.text_length(line+char,fontsize=size)>width*MM:break
                            line+=char
                        if remaining and not line:raise ValueError('Text glyph does not fit')
                        page.insert_text((25*MM,(y+size/MM)*MM),line,fontname='aec',fontsize=size)
                        y+=size/MM*1.5;remaining=remaining[len(line):]
                        if not remaining:break

            def display(value):
                if isinstance(value,dict) and set(value)=={'value','unit'}:
                    return format(float(value['value']),'.10g')+' '+value['unit']
                return str(value)

            def label(name):
                return LABELS.get(name,'Строка '+name[4:] if name.startswith('row_') else name)

            for case in case_items:
                start('A4',case['title'])
                paragraph('Основание: '+case['basis'])
                paragraph('Метод: '+METHODS[case['data']['method']]['title'])
                paragraph('Рабочий расчёт. Применимость исходных данных и критериев требует проверки.')
                for name,value in case['data']['normalized_inputs'].items():
                    paragraph(label(name)+': '+display(value))
                if case['data']['method']=='sum_products':
                    for index,row in enumerate(case['data']['inputs']['rows'],1):
                        paragraph('Строка '+str(index)+': '+str(row['quantity'])+' × '+display(row['unit_value']))
                for step in case['data']['trace']:
                    formula=step['formula']
                    for key in sorted(LABELS,key=len,reverse=True):formula=formula.replace(key,LABELS[key])
                    paragraph(label(step['name'])+' = '+formula+' = '+display({k:step[k] for k in ('value','unit')}))
                    if step.get('substitution') and step['substitution']!=step['formula']:
                        paragraph('Подстановка: '+step['substitution']+' = '+display({k:step[k] for k in ('value','unit')}))
                for comparison in case['data']['reported_comparisons']:
                    status='совпадает в пределах допуска' if comparison['status']=='matches' else 'расходится'
                    paragraph('Сравнение: '+label(comparison['output'])+' — '+status+'; в источнике '+display(comparison['reported'])+
                              '; разность '+display(comparison['difference'])+'; допуск '+display(comparison['tolerance']))
                for check in case['data']['criteria_checks']:
                    status='выполнен' if check['status']=='satisfied' else 'не выполнен'
                    paragraph('Критерий '+label(check['output'])+' '+check['operator']+' '+display(check['value'])+': '+status+'; '+check['basis'])
                for assumption in case['assumptions']:paragraph('Допущение: '+assumption)
                for source in case['sources']:
                    record,_=self.workspace.source_record(self.project_id,source['doc_id'])
                    page_label='; стр. PDF '+str(source['page_number']) if 'page_number' in source else ''
                    paragraph('Источник: '+record['relative_path']+page_label+'; '+source['reason'])
                paragraph('Границы метода: '+case['data']['coverage'])

            def draw_entity(entity,body,offset=(0,0),scale=1):
                if not isinstance(entity,dict):raise ValueError('Drawing entity must be an object')
                kind=entity.get('type');ox,oy=offset
                def point(p):
                    if not isinstance(p,list) or len(p)!=2:raise ValueError('Two point coordinates required')
                    return fitz.Point((ox+finite(p[0])*scale)*MM,(oy+finite(p[1])*scale)*MM)
                weight=finite(entity.get('width_mm',.25),.05,2)*MM
                if kind=='symbol':
                    symbol=definitions.get(entity.get('symbol_id'))
                    if symbol is None:raise ValueError('Used symbol is not defined in the legend')
                    position=point(entity['origin_mm']);factor=finite(entity.get('scale',1),.01,100)*scale
                    for child in symbol['entities']:draw_entity(child,body,(position.x/MM,position.y/MM),factor)
                    return symbol['id']
                if kind=='line':
                    points=entity.get('points_mm')
                    if not isinstance(points,list) or len(points)!=2:raise ValueError('A line needs two points')
                    a,b=map(point,points);rect=fitz.Rect(min(a.x,b.x),min(a.y,b.y),max(a.x,b.x),max(a.y,b.y))
                    # Rect.contains treats zero-area line boxes as empty; test endpoints.
                    if not body.contains(a) or not body.contains(b):raise ValueError('Line outside drawing body')
                    page.draw_line(a,b,width=weight)
                elif kind in {'rectangle','text'}:
                    box=rectangle(entity['rect_mm']);a=point(box[:2]);b=point(box[2:]);rect=fitz.Rect(a,b)
                    if not body.contains(rect):raise ValueError('Entity outside drawing body or overlaps title/legend')
                    if kind=='rectangle':page.draw_rect(rect,width=weight)
                    else:
                        size=finite(entity.get('font_size_pt',9),4,72)*scale
                        value=text(entity.get('text'))
                        if page.insert_textbox(rect,value,fontname='aec',fontsize=size,lineheight=1.25)<-.01:
                            raise ValueError('Drawing text overflow; enlarge or split its rectangle')
                elif kind=='circle':
                    center=point(entity['center_mm']);radius=finite(entity['radius_mm'],.1,100)*scale*MM
                    rect=fitz.Rect(center.x-radius,center.y-radius,center.x+radius,center.y+radius)
                    if not body.contains(rect):raise ValueError('Circle outside drawing body')
                    page.draw_circle(center,radius,width=weight)
                else:raise ValueError('Unsupported drawing entity')
                return None

            for sheet in pages:
                if not isinstance(sheet,dict) or set(sheet)!={'format','title','entities'}:raise ValueError('Invalid drawing sheet')
                text(sheet['title'],300)
                entities=sheet['entities']
                if not isinstance(entities,list) or not 1<=len(entities)<=2000:raise ValueError('Choose 1–2000 drawing entities')
                used=sorted({e.get('symbol_id') for e in entities if isinstance(e,dict) and e.get('type')=='symbol'},key=str)
                if any(key not in definitions for key in used):raise ValueError('Undefined symbol')
                width,height,top,stamp=start(sheet['format'],sheet['title'])
                # Reserve a same-sheet legend; no inferred equivalence of symbol standards.
                legend_height=len(used)*8
                body=fitz.Rect(22*MM,22*MM,(width-7)*MM,(top-3-legend_height)*MM)
                if body.is_empty:raise ValueError('Legend leaves no drawing area')
                for entity in entities:draw_entity(entity,body)
                for index,key in enumerate(used):
                    symbol=definitions[key];ly=top-3-legend_height+index*8
                    # Draw the declared glyph as well as its label in the legend.
                    bounds=[]
                    for entity in symbol['entities']:
                        kind=entity.get('type')
                        if kind=='line':
                            points=entity['points_mm'];bounds.extend(points)
                        elif kind in {'rectangle','text'}:
                            box=rectangle(entity['rect_mm']);bounds.extend([box[:2],box[2:]])
                        elif kind=='circle':
                            cx,cy=entity['center_mm'];r=entity['radius_mm']
                            bounds.extend([[cx-r,cy-r],[cx+r,cy+r]])
                    if not bounds:raise ValueError('Symbol needs visible bounded geometry')
                    xs=[finite(p[0]) for p in bounds];ys=[finite(p[1]) for p in bounds]
                    factor=min(12/max(max(xs)-min(xs),.1),6/max(max(ys)-min(ys),.1))
                    origin=(31-factor*(min(xs)+max(xs))/2,ly+3.5-factor*(min(ys)+max(ys))/2)
                    for entity in symbol['entities']:
                        draw_entity(entity,fitz.Rect(24*MM,ly*MM,38*MM,(ly+7)*MM),origin,factor)
                    write_box([42,ly,width-10,ly+7],key+': '+symbol['label']+'; '+symbol['basis'],7)
                generated[-1]['used_symbols']=used
            pdf.set_metadata({'title':title,'subject':metadata['designation'],'creator':'Увязка; '+LAYOUT})
            temp=folder/(uuid4().hex+'.pdf')
            try:
                pdf.save(temp,garbage=4,deflate=True);pdf.close();temp.replace(target)
            finally:
                if not pdf.is_closed:pdf.close()
                if temp.exists():temp.unlink()
            generation={'artifact':str(target),'sha256':digest(target),'layout_revision':LAYOUT,'pages':generated,
                        'normative_status':'working_layout_requires_applicable_form_and_symbol_review',
                        'signatures_generated':False}
            (folder/(identity+'.json')).write_text(encode(generation),encoding='utf-8')
        data={'definition':definition,'calculation_refs':calculations,'generation':generation}
        return self.work.save('document',document_id,title,basis,source_links,declared,data,
                              request_id,expected_revision,reason)

    def path_folder(self,document_id):
        identifier(document_id)
        return self.workspace.db_path(self.project_id).parent/'engineering-exports'/document_id

    def check(self,check_id,title,pages,requirements,basis,request_id,document_id=None,document_revision=None,
              doc_id=None,sha256=None,expected_revision=0,reason=''):
        import pymupdf as fitz
        if bool(document_id)==bool(doc_id):raise ValueError('Choose one generated document or registered PDF source')
        if document_id:
            item=self.work.get('document',document_id,document_revision)['items'][0]
            artifact=item['data']['generation'];target=Path(artifact['artifact'])
            if not target.is_file() or digest(target)!=artifact['sha256']:raise ValueError('Generated PDF bytes changed')
            if not item['current_sources'] or not item.get('current_calculations',True):
                raise ValueError('Document inputs changed; rebuild or review the old version explicitly')
            with fitz.open(target) as pdf:report=inspect_pdf(pdf,pages,requirements)
            if digest(target)!=artifact['sha256']:raise ValueError('PDF changed during check')
            sources=item['sources'];assumptions=item['assumptions'] or ['Generated working document; applicable criteria supplied by caller']
            report['document_ref']={'document_id':document_id,'revision':item['revision'],'sha256':artifact['sha256']}
        else:
            from .pdf_source import open_pdf
            if not sha256:raise ValueError('Pin the registered source SHA-256')
            with open_pdf(self.workspace,self.project_id,doc_id,sha256) as pdf:
                report=inspect_pdf(pdf,pages,requirements)
            sources=[{'doc_id':doc_id,'sha256':sha256,'reason':'PDF formatting check against explicit criteria'}];assumptions=[]
        report['requirements']=requirements
        return self.work.save('document_check',check_id,title,basis,sources,assumptions,report,
                              request_id,expected_revision,reason)
