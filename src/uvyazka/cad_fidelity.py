"""Compare supported 2D DXF content after a converter round trip.

No native application, source changes, font embedding or engineering approval.
"""
from collections import Counter
import math
import hashlib
from pathlib import Path

SUPPORTED = {'LINE','LWPOLYLINE','POLYLINE','VERTEX','SEQEND','TEXT','MTEXT','ATTRIB','ATTDEF','INSERT','CIRCLE','ARC','ELLIPSE','SOLID','TRACE','3DFACE','POINT','VIEWPORT'}
IDENTITY = {'handle','owner'}


def checker_revision():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def equal(a, b, tolerance=1e-7):
    if isinstance(a, (int,float)) and not isinstance(a,bool) and isinstance(b,(int,float)) and not isinstance(b,bool):
        return math.isclose(a,b,rel_tol=0,abs_tol=tolerance)
    if a is None or b is None:return a is b
    if isinstance(a,str) or isinstance(b,str):return isinstance(a,str) and isinstance(b,str) and a==b
    if isinstance(a,dict) or isinstance(b,dict):
        return isinstance(a,dict) and isinstance(b,dict) and a.keys()==b.keys() and all(equal(a[k],b[k],tolerance) for k in a)
    try:
        aa,bb=list(a),list(b)
        return len(aa)==len(bb) and all(equal(x,y,tolerance) for x,y in zip(aa,bb))
    except TypeError:return a==b


def compare_dxf(source, derived):
    import ezdxf
    a,b=ezdxf.readfile(source),ezdxf.readfile(derived)
    differences=[];normalizations=Counter();counts=Counter();unsupported=Counter();attributes=0
    def check(label,u,v):
        if not equal(u,v):
            if len(differences)<200:differences.append({'at':label,'before':str(u)[:500],'after':str(v)[:500]})
            counts['differences']+=1
    def attrs(u,v,label,skip=()):
        keys=u.dxfattribs().keys()|v.dxfattribs().keys()
        for k in sorted(keys-IDENTITY-set(skip)):
            x,y=getattr(u.dxf,k,None),getattr(v.dxf,k,None)
            if u.dxftype()=='MTEXT' and k in {'defined_height','width'} and x is None and y==0:
                normalizations['mtext_optional_unbounded_'+k]+=1;continue
            if u.dxftype()=='LAYOUT' and k=='plot_configuration_file' and x=='' and y=='none_device':
                normalizations['layout_no_plot_device']+=1;continue
            if u.dxftype()=='LAYOUT' and k=='taborder' and x!=y:
                normalizations['taborder_gap_compacted']+=1;continue  # visible order is compared separately
            if u.dxftype()=='LAYER' and k=='unknown1' and x is None and y=='0':
                normalizations['layer_optional_null_reference']+=1;continue
            if u.dxftype()=='LAYER' and k=='color' and x!=y and (x<0)==(y<0) and u.dxf.hasattr('true_color') and v.dxf.hasattr('true_color') and u.dxf.true_color==v.dxf.true_color:
                normalizations['aci_fallback_changed_with_identical_rgb']+=1;continue
            if k in {'linetype','style','dimstyle','layer','font','bigfont'}:
                if isinstance(x,str):x=x.casefold()
                if isinstance(y,str):y=y.casefold()
            # Left/baseline text uses insert; optional alignment point is unused.
            if k=='align_point' and u.dxftype() in {'TEXT','ATTRIB','ATTDEF'} and all(getattr(z.dxf,'halign',0)==getattr(z.dxf,'valign',0)==0 for z in [u,v]):
                if not equal(x,y):normalizations['unused_left_baseline_alignment_point']+=1
                continue
            # ODA adds display/grid defaults to 2D viewports. Preserve their existence as diagnostics.
            defaults={'ambient_light_color_1':256,'default_lighting_flag':1,'grid_frequency':5,'shade_plot_mode':0,'view_brightness':0.0,'view_contrast':0.0}
            if u.dxftype()=='VIEWPORT':
                if k=='default_lighting_flag' and x==0 and y==1 and all(getattr(z.dxf,'render_mode',0)==0 and not getattr(z.dxf,'view_mode',0)&1 for z in [u,v]):
                    normalizations['viewport_inactive_3d_lighting_flag']+=1;continue
                if k=='id':
                    if x!=y:normalizations['viewport_internal_number']+=1
                    continue
                if k in defaults and x is None and y==defaults[k]:normalizations['viewport_optional_'+k]+=1;continue
                if k=='visual_style_handle' and x is None and y:
                    entity=b.entitydb.get(y)
                    if entity is not None and entity.dxf.get('description','') in ['2dWireframe','2D Wireframe','2d Wireframe']:
                        normalizations['viewport_default_2d_style']+=1;continue
            check(label+'.'+k,x,y)
    def entity(u,v,label):
        nonlocal attributes
        counts[u.dxftype()]+=1
        check(label+'.type',u.dxftype(),v.dxftype())
        if u.dxftype() not in SUPPORTED:unsupported[u.dxftype()]+=1
        if u.has_extension_dict or v.has_extension_dict:unsupported['ENTITY_EXTENSION_DICTIONARY']+=1
        attrs(u,v,label)
        kind=u.dxftype()
        if kind=='LWPOLYLINE':check(label+'.points',list(u.get_points()),list(v.get_points()))
        if kind=='MTEXT':
            check(label+'.content',u.text,v.text)
            if u.has_columns or v.has_columns:unsupported['MTEXT_COLUMNS']+=1
        if kind=='VIEWPORT':check(label+'.frozen_layers',list(u.frozen_layers),list(v.frozen_layers))
        if kind=='POLYLINE':
            check(label+'.vertices',len(u.vertices),len(v.vertices))
            for i,(aa,bb) in enumerate(zip(u.vertices,v.vertices)):attrs(aa,bb,label+f'.vertex[{i}]')
        if kind=='INSERT':
            check(label+'.attribute_count',len(u.attribs),len(v.attribs))
            for aa,bb in zip(u.attribs,v.attribs):
                attributes+=1;attrs(aa,bb,label+'.attribute['+aa.dxf.tag+']')
                if aa.has_embedded_mtext_entity or bb.has_embedded_mtext_entity:unsupported['EMBEDDED_ATTRIBUTE_MTEXT']+=1
                if aa.has_extension_dict or bb.has_extension_dict:unsupported['ATTRIBUTE_EXTENSION_DICTIONARY']+=1
        # Unknown extension data cannot be silently certified.
        if bool(u.xdata)!=bool(v.xdata):check(label+'.xdata_presence',bool(u.xdata),bool(v.xdata))
        elif u.xdata and repr(u.xdata.data)!=repr(v.xdata.data):
            check(label+'.xdata',repr(u.xdata.data),repr(v.xdata.data))
    def space(u,v,label):
        check(label+'.entity_count',len(u),len(v))
        handles={e.dxf.handle:e for e in v}
        for e in u:
            other=handles.get(e.dxf.handle)
            if other is None:check(label+'.handle['+e.dxf.handle+']',e.dxftype(),None)
            else:entity(e,other,label+'.'+e.dxf.handle)
    check('layout_order',a.layout_names_in_taborder(),b.layout_names_in_taborder())
    for lo in a.layouts:
        if lo.name not in b.layout_names():continue
        other=b.layouts.get(lo.name)
        attrs(lo.dxf_layout,other.dxf_layout,'layout.'+lo.name,{'block_record_handle','viewport_handle'})
        space(lo,other,'layout.'+lo.name)
        if lo.block_record_name!=other.block_record_name:normalizations['internal_paperspace_block_name']+=1
    an={lo.block_record_name.casefold() for lo in a.layouts};bn={lo.block_record_name.casefold() for lo in b.layouts}
    ab={z.name.casefold():z for z in a.blocks if z.name.casefold() not in an};bb={z.name.casefold():z for z in b.blocks if z.name.casefold() not in bn}
    check('named_block_names',sorted(ab),sorted(bb))
    for name,block in ab.items():
        if name not in bb:continue
        if block.block_record.has_extension_dict or bb[name].block_record.has_extension_dict:unsupported['BLOCK_EXTENSION_DICTIONARY']+=1
        attrs(block.block,bb[name].block,'block.'+name)
        attrs(block.block_record,bb[name].block_record,'block_record.'+name,{'layout'})
        space(block,bb[name],'block.'+name)
    for table in ['styles','layers','linetypes']:
        aa={x.dxf.name.casefold():x for x in getattr(a,table)};zz={x.dxf.name.casefold():x for x in getattr(b,table)}
        extras=set(zz)-set(aa)
        if table=='layers' and extras:
            used={e.dxf.get('layer','0').casefold() for block in b.blocks for e in block}
            for name in extras-used:
                normalizations['added_unreferenced_layer']+=1;zz.pop(name)
            for name in extras&used:
                users=[e for block in b.blocks for e in block if e.dxf.get('layer','0').casefold()==name]
                layer=zz[name]
                default_layer=layer.dxf.color==7 and layer.dxf.flags==0 and layer.dxf.linetype.casefold()=='continuous' and layer.dxf.lineweight==-3 and not layer.dxf.hasattr('true_color')
                if default_layer and all(e.dxftype()=='VIEWPORT' for e in users):
                    normalizations['added_default_paperspace_viewport_layer']+=1;zz.pop(name)
        check(table+'.names',sorted(aa),sorted(zz))
        for name,u in aa.items():
            if name not in zz:continue
            attrs(u,zz[name],table+'.'+name,{'name'})
            if table=='linetypes':check(table+'.'+name+'.pattern',list(u.pattern_tags.tags),list(zz[name].pattern_tags.tags))
    for key in ['$INSUNITS','$MEASUREMENT','$LUNITS','$AUNITS']:check('header.'+key,a.header.get(key),b.header.get(key))
    audit=b.audit();check('audit_errors',0,len(audit.errors))
    return {'passed':not differences and not unsupported,'difference_count':counts.pop('differences',0),'differences':differences,
        'checker_revision':checker_revision(),'ezdxf_version':ezdxf.__version__,
        'unsupported_entities':dict(unsupported),'checked_entities':sum(counts.values()),'entity_types':dict(counts),'attributes':attributes,
        'paper_layouts':len(a.layouts)-1,'named_blocks':len(ab),'styles':len(a.styles),'normalizations':dict(normalizations),
        'absolute_geometry_tolerance_drawing_units':1e-7,'scope':'Decoded supported 2D geometry, text/attributes, layers/styles, named blocks, layouts and viewport settings. Not rendered print fidelity or engineering approval.'}
