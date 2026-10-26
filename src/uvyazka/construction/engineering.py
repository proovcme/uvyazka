"""Explicit file topology only. Membership is never promoted to a connection."""
from collections import deque

KINDS={'IfcRelConnectsPortToElement':'port_owner','IfcRelConnectsPorts':'port_connection',
       'IfcRelConnectsElements':'element_connection','IfcRelConnectsPathElements':'element_connection',
       'IfcRelFlowControlElements':'control'}


def network_page(model,node_id='',target_id='',mode='physical',offset=0,limit=100):
    if mode not in {'physical','membership','all'} or type(offset) is not int or offset<0 or type(limit) is not int or not 1<=limit<=200:raise ValueError('Invalid graph query')
    nodes={e['id']:{'id':e['id'],'name':e['name'],'class':e['class'],'role':'port' if 'IfcPort' in e['hierarchy'] else 'element','geometry':bool(e.get('mesh'))} for e in model['elements']}
    owners={e['id']:e for e in model['elements']}
    for s in model.get('systems',[]):nodes[s['id']]={'id':s['id'],'name':s['name'],'class':s['class'],'role':'system','geometry':False}
    links=[];seen=set();assigned={(l['from'],l['to']) for l in model.get('engineering_links',[]) if l.get('kind')=='membership' and all(l.get('source',{}).get(k) for k in ['sha256','relation_id','relation_class'])}
    def add(parent,child,kind,rid,cls,source=None):
        if not parent or not child or parent==child:return
        key=(kind,rid,parent,child)
        if key in seen:return
        seen.add(key)
        owner=owners.get(parent,owners.get(child,{}))
        evidence=source or {'sha256':owner.get('source',{}).get('file_sha256',model['source']['sha256']),'relation_id':rid,'relation_class':cls}
        links.append({'from':parent,'to':child,'kind':kind,'source':evidence})
        for node in [parent,child]:
            if node not in nodes:nodes[node]={'id':node,'name':'Unread reference','class':'Unknown','role':'unread','geometry':False}
    for r in model['relationships']:
        kind=KINDS.get(r['class'])
        if r['class']=='IfcRelAssignsToGroup' and nodes.get(r['parent_id'],{}).get('role')=='system':kind='membership'
        for child in r['child_ids']:
            current='port_owner' if r['class']=='IfcRelNests' and nodes.get(child,{}).get('role')=='port' else kind
            if current:
                add(r['parent_id'],child,current,str(r.get('source_instance_id',''))+':'+str(r['step_id']),r['class'])
                if current=='membership':assigned.add((r['parent_id'],child))
    for s in model.get('systems',[]):
        for child in s['member_ids']:
            if (s['id'],child) not in assigned:add(s['id'],child,'membership',s['id'],'ExtractedSystemMembership')
    for link in model.get('engineering_links',[]):
        source=link.get('source',{})
        if link.get('kind') in {*KINDS.values(),'membership','base_equipment'} and all(source.get(k) for k in ['sha256','relation_id','relation_class']):add(link['from'],link['to'],link['kind'],source['relation_id'],source['relation_class'],source)
    adjacency={}
    for link in links:
        for key in [link['from'],link['to']]:adjacency.setdefault(key,[]).append(link)
    path=None
    if target_id:
        if node_id not in nodes or target_id not in nodes or nodes[node_id]['role']=='unread' or nodes[target_id]['role']=='unread':
            return {'model_id':model['model_id'],'path':{'status':'unknown_endpoint','nodes':[],'links':[]},'note':'One or both endpoints have not been read.'}
        allowed={'port_owner','port_connection','element_connection'} if mode=='physical' else {'membership','base_equipment'} if mode=='membership' else {x['kind'] for x in links}
        queue=deque([node_id]);previous={};visited={node_id};found=False
        while queue and len(visited)<=20000:
            current=queue.popleft()
            if current==target_id and nodes.get(current,{}).get('role')!='unread':found=True;break
            for edge in adjacency.get(current,[]):
                next_id=edge['to'] if edge['from']==current else edge['from']
                if edge['kind'] in allowed and next_id not in visited and nodes[next_id]['role']!='unread':visited.add(next_id);previous[next_id]=(current,edge);queue.append(next_id)
        path={'status':'found' if found else 'budget_exceeded' if len(visited)>20000 else 'not_found_in_read_graph','nodes':[],'links':[]}
        if found:
            key=target_id;path['nodes']=[key]
            while key!=node_id:
                key,edge=previous[key];path['nodes'].insert(0,key);path['links'].insert(0,edge)
    rows=adjacency.get(node_id,[]) if node_id else links
    page=rows[offset:offset+limit];ids={key for edge in page for key in [edge['from'],edge['to']]}
    return {'model_id':model['model_id'],'source':model['source'],'node':nodes.get(node_id),'nodes':[nodes[key] for key in sorted(ids)],'links':page,'total':len(rows),'next_offset':offset+limit if offset+limit<len(rows) else None,'path':path,'coverage':{'unread_nodes':sum(n['role']=='unread' for n in nodes.values()),'physical_links':sum(e['kind'] in {'port_connection','element_connection'} for e in links)},'note':'Explicit file topology. Membership does not prove connection or supply; paths do not verify internal continuity, capacity or function. No path in read data is not proof of missing connection.'}
