"""Exact, bounded arithmetic over immutable XLSX cells. No Excel execution.

The caller chooses an expression and its engineering meaning. Only scalar
numbers, same-sheet A1 references, + - * / and parentheses are supported.
"""
import ast
from decimal import Decimal, localcontext
from fractions import Fraction
import json
import re

from .core import connection
from .document_tables import bounded
from .structure_analysis import StructureAnalysis
from .structured_readers import engine

REVISION = 'source-arithmetic-v1'
REFERENCE = re.compile(r'([A-Z]{1,3})([1-9][0-9]*)\Z')
SCALAR = re.compile(r'[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z')


def scalar(text):
    if not isinstance(text, str) or len(text)>180 or not SCALAR.fullmatch(text.strip()):
        raise ValueError('A literal scalar number is required; text/empty/boolean is not zero')
    value = Decimal(text.strip())
    if len(value.as_tuple().digits)>64 or abs(value.as_tuple().exponent)>100:
        raise ValueError('Numeric literal exceeds 64 digits or exponent 100')
    return Fraction(value)


def checked(value):
    if max(value.numerator.bit_length(), value.denominator.bit_length())>2048:
        raise ValueError('Arithmetic result exceeds 2048 bits')
    return value


def result_number(value):
    denominator=value.denominator;powers=[]
    for factor in (2,5):
        power=0
        while denominator%factor==0:denominator//=factor;power+=1
        powers.append(power)
    with localcontext() as context:
        context.prec=28
        decimal=Decimal(value.numerator)/Decimal(value.denominator)
    literal=f'{value.numerator}/{value.denominator}'
    if denominator==1:
        places=max(powers)
        scaled=abs(value.numerator)*2**(places-powers[0])*5**(places-powers[1])
        digits=str(scaled).zfill(places+1)
        literal=(('-' if value<0 else '')+(digits[:-places]+'.'+digits[-places:] if places else digits))
        if '.' in literal:literal=literal.rstrip('0').rstrip('.')
    return dict(value=literal,exact=f'{value.numerator}/{value.denominator}',decimal_approximation=str(decimal),terminating_decimal=denominator==1)


class StructureCalculation:
    def __init__(self,workspace,project_id):
        self.workspace,self.project_id=workspace,project_id
        self.path=workspace.db_path(project_id)

    def calculate(self,table_id,expression):
        with connection(self.path,readonly=True) as db:
            card=StructureAnalysis(self.workspace,self.project_id).table(db,table_id)
            source=card['source'];record,_=self.workspace.source_record(self.project_id,source['doc_id'])
            if card['unit_kind']!='excel_sheet' or record['extension'] not in {'.xlsx','.xlsm'}:
                raise ValueError('Arithmetic requires an XLSX/XLSM worksheet; XLS does not expose formula expressions')
            self.fresh(card,record)
            cells,values,visiting,row_cache={},{},[],{}
            operations=0

            def evaluate(raw,depth=0):
                nonlocal operations
                if not isinstance(raw,str) or not raw.strip() or len(raw)>2048 or depth>32:
                    raise ValueError('Expression exceeds 2048 characters or dependency depth 32')
                raw=raw.strip().removeprefix('=').strip()
                # Normalize only complete cell references, never arbitrary dollar signs.
                raw=re.sub(r'(?<![\w$])\$?([A-Za-z]{1,3})\$?([1-9][0-9]*)(?![\w$])',lambda m:m[1].upper()+m[2],raw)
                if not re.fullmatch(r'[A-Za-z0-9+*/().\s-]+',raw):
                    raise ValueError('Only numbers, same-sheet A1 references and + - * / are supported')
                try:tree=ast.parse(raw,mode='eval')
                except (SyntaxError,RecursionError) as exc:raise ValueError('Unsupported arithmetic syntax') from exc
                if sum(1 for _ in ast.walk(tree))>512:raise ValueError('Expression exceeds 512 syntax nodes')

                def walk(node,level):
                    nonlocal operations
                    operations+=1
                    if operations>4096 or level>64:raise ValueError('Arithmetic exceeds operation/depth budget')
                    if isinstance(node,ast.Constant) and type(node.value) in (int,float):
                        return scalar(ast.get_source_segment(raw,node))
                    if isinstance(node,ast.Name):return cell(node.id,depth+1)
                    if isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)):
                        value=walk(node.operand,level+1)
                        return value if isinstance(node.op,ast.UAdd) else -value
                    if isinstance(node,ast.BinOp) and isinstance(node.op,(ast.Add,ast.Sub,ast.Mult,ast.Div)):
                        a,b=walk(node.left,level+1),walk(node.right,level+1)
                        if isinstance(node.op,ast.Add):value=a+b
                        elif isinstance(node.op,ast.Sub):value=a-b
                        elif isinstance(node.op,ast.Mult):value=a*b
                        else:
                            if b==0:raise ValueError('Division by zero; no cached-value fallback')
                            value=a/b
                        return checked(value)
                    raise ValueError('Unsupported operator/function; only + - * / and cell references are evaluated')
                return checked(walk(tree.body,0))

            def cell(address,depth):
                if depth>32:raise ValueError('Cell dependency depth exceeds 32')
                match=REFERENCE.fullmatch(address)
                if not match:raise ValueError('Named ranges/functions are unsupported: '+address)
                if address in visiting:raise ValueError('Circular reference: '+' -> '.join([*visiting,address]))
                if address in values:return values[address]
                if len(cells)>=128:raise ValueError('Expression exceeds 128 referenced cells')
                column=0
                for letter in match[1]:column=column*26+ord(letter)-64
                row=int(match[2])
                if row>card['row_count'] or column>card['column_count']:
                    raise ValueError('Cell outside the stored worksheet: '+address)
                if row not in row_cache:
                    saved=db.execute('select payload from structure_rows where table_id=? and row_number=?',(table_id,row)).fetchone()
                    row_cache[row]=json.loads(saved[0]) if saved else []
                original=next((c for c in row_cache[row] if c['column']==column),None)
                if not original or original['state'] not in {'value','formula'}:
                    raise ValueError('Cell '+address+' is empty, absent or a merged continuation; not zero')
                cells[address]=dict(address=address,cell_id=original['cell_id'],literal=original['text'],
                                    state=original['state'],formula=original.get('formula'),cached_value=original.get('cached_value'),
                                    locator=original['locator'])
                visiting.append(address)
                try:
                    if original['state']=='formula':
                        value=evaluate(original.get('formula'),depth)
                        cached=original.get('cached_value')
                        try:comparison='missing' if cached is None else 'matches' if scalar(cached)==value else 'differs'
                        except ValueError:comparison='not_numeric'
                        cells[address]['cache_comparison']=comparison
                    else:
                        if original.get('value_type')!='n':raise ValueError('Cell '+address+' is not a numeric Excel value')
                        value=scalar(original['text'])
                    values[address]=value;cells[address]['calculated']=result_number(value)
                    return value
                finally:visiting.pop()

            value=evaluate(expression)
            # Recheck the actual file after reading the cached dependency graph.
            record,_=self.workspace.source_record(self.project_id,source['doc_id']);self.fresh(card,record)
        trace=list(cells.values())
        return bounded(dict(project_id=self.project_id,table_id=table_id,expression=expression,
                            calculator_revision=REVISION,source=source,source_engine=card['engine'],
                            source_freshness='actual_hash_matches',result=result_number(value),cells=trace,
                            cached_discrepancies=sum(c.get('cache_comparison')=='differs' for c in trace),
                            unresolved_caches=sum(c.get('cache_comparison') in {'missing','not_numeric'} for c in trace),
                            units_status='caller_must_check_units_and_quantity_basis',accepted=False,
                            note='Supported scalar arithmetic only. No Office execution, external links, ranges, functions or source writes.'))

    def fresh(self,card,record):
        source=card['source']
        if record['sha256']!=source['sha256'] or card['engine']!=engine(record['extension']) or self.workspace.source_state(self.project_id,source['doc_id'],full_hash=True)['status']!='content_hash_matches':
            raise ValueError('Source or reader changed; refresh source structure before calculation')
