"""Opt-in real-worker smoke benchmark on synthetic Russian engineering texts.
No network, private project files, mocked vectors or engineering acceptance.
Pass a new --output directory. Six texts are not a representative evaluation.
"""
import argparse
import json
from pathlib import Path
import time
from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.embedding_worker import configuration,close_providers
from uvyazka.semantic_search import SemanticSearch

CORPUS={
 'water.txt':'Холодное водоснабжение. Повысительная установка обеспечивает требуемое давление на верхних этажах. Основной и резервный насосы Н-1 и Н-2. Мощность каждого электродвигателя 4 кВт.',
 'ventilation.txt':'Общеобменная вентиляция. Приточная установка П1 подаёт наружный воздух в кабинеты. Воздух проходит фильтрацию и нагрев в водяном калорифере. Расход 3500 м³/ч.',
 'electrical.txt':'Электроснабжение насосной. Щит ЩН питает электродвигатели станции повышения давления. Кабель ВВГнг-LS 5х4. Автоматический выключатель QF1, номинальный ток 25 А.',
 'fire.txt':'Система противопожарной защиты. При пожаре приточная вентиляция отключается, открываются клапаны дымоудаления. Сигналы состояния передаются на пост охраны.',
 'architecture.txt':'Экспликация помещений. Помещение 313 — серверная, площадь 18,4 м². Дверь противопожарная EI60. Отметка чистого пола третьего этажа +7,200.',
 'structure.txt':'Фундаментная плита толщиной 600 мм. Бетон B30 W8 F150. Рабочая арматура класса А500С. Защитный слой нижней арматуры 50 мм.'}
QUERIES=[
 ('чем обеспечивается напор воды наверху здания','water.txt','paraphrase'),
 ('какой провод проложен к двигателям насосов','electrical.txt','paraphrase'),
 ('что происходит с вентиляцией при возгорании','fire.txt','paraphrase'),
 ('площадь комнаты для серверного оборудования','architecture.txt','paraphrase'),
 ('какой материал несущего основания здания','structure.txt','paraphrase'),
 ('ВВГнг-LS','electrical.txt','literal'),
 ('Н-1','water.txt','identifier'),('Н-10',None,'negative'),
 ('какие лифты установлены в здании',None,'negative')]

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--home',required=True,help='Only reads the worker configuration from this home')
    p.add_argument('--output',required=True,help='New synthetic workspace and report directory');args=p.parse_args()
    config=configuration(Path(args.home))
    if not config:p.error('Configure a real local worker first')
    output=Path(args.output).resolve();output.mkdir(parents=True,exist_ok=False);sources=output/'sources';sources.mkdir()
    for name,value in CORPUS.items():(sources/name).write_text(value,encoding='utf-8')
    ws=Workspace(output/'state');ws.create_project('eval','Synthetic Russian retrieval smoke benchmark',sources);scan(ws,'eval')
    (ws.home/'embedding-worker.json').write_text(json.dumps(config),encoding='utf-8')
    service=SemanticSearch(ws,'eval');start=time.monotonic();built=service.build(limit=64)
    report=dict(scope='Synthetic 6-text smoke benchmark; no project-wide/engineering acceptance',cutoff=.72,
                model=built['status']['active_space'],build_seconds=round(time.monotonic()-start,3),queries=[])
    # Fixed run: report ranks/negative hits at .72; do not tune while evaluating.
    try:
        for query,expected,kind in QUERIES:
            for mode in ['literal','semantic','hybrid']:
                start=time.monotonic();r=service.search(query,mode=mode)
                hits=[dict(path=x['relative_path'],similarity=x['similarity'],locator=x['locator'],sha256=x['sha256']) for x in r['results']]
                paths=[x['path'] for x in hits]
                item=dict(query=query,kind=kind,expected=expected,requested=mode,effective=r['effective_mode'],fallback=r['fallback_reason'],
                          seconds=round(time.monotonic()-start,3),top1=bool(paths and paths[0]==expected) if expected else None,
                          top3=expected in paths[:3] if expected else None,negative_hits=len(paths) if expected is None else None,hits=hits)
                report['queries'].append(item);print(json.dumps({k:v for k,v in item.items() if k!='hits'},ensure_ascii=False),flush=True)
        (output/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    finally:close_providers()

if __name__=='__main__':main()
