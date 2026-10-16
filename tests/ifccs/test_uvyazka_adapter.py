"""Exercise the MCP adapter against project-scoped Uvyazka storage."""
import json
import pytest
from uvyazka.core import Workspace
from uvyazka.ingest import scan
from uvyazka.construction.authoring_tools import register_tools
from uvyazka.construction.planning import Planning
from test_authoring import plan_file, model_spec


class Tools:
    def __init__(self): self.functions = {}
    def tool(self, **kwargs):
        def register(function):
            self.functions[function.__name__] = function
            return function
        return register


def test_registered_drawing_build_federation_and_changed_source(workspace_temp):
    root = workspace_temp / 'adapter'; root.mkdir()
    source = plan_file(root)
    original = source.read_bytes()
    workspace = Workspace(workspace_temp / 'adapter-state')
    workspace.create_project('one', 'Synthetic adapter', root)
    other = root / 'other'; other.mkdir()
    workspace.create_project('two', 'Other project', other)
    scan(workspace, 'one')
    document = workspace.find_documents('one', source.name)['documents'][0]
    tools = Tools(); register_tools(tools, workspace); call = tools.functions
    assert 'elements' in call['ifc_authoring_schema']()['model']['properties']
    drawing = call['create_drawing_model']('one', 'Synthetic drawing')
    key = drawing['drawing_id']
    registered = call['register_model_drawing']('one', key, document['doc_id'], 0)
    assert registered['project_id'] == 'one' and registered['drawing_id'] == key
    source_id = registered['source']['id']
    call['save_ifc_model_spec']('one', key, 1, model_spec(source_id))
    result = call['build_drawing_model']('one', key, 2, 'build')
    assert result['project_id'] == 'one' and result['drawing_id'] == key
    assert result['build']['viewer_url'] == '/simulation/?project=one'
    planning = Planning(workspace); model_id = result['model']['model_id']
    model = planning.model('one', model_id)
    assert model['source']['sources'][0]['doc_id'] == document['doc_id']
    manifest = json.loads((planning.model_path('one', model_id) / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest == model
    assert call['get_drawing_model']('one', key, limit=1)['next_offset'] == 1
    with pytest.raises(ValueError): call['get_drawing_model']('two', key)
    with pytest.raises(ValueError): planning.model('two', model_id)
    federation = call['federate_spatial_models']('one', [
        {'model_id': model_id, 'instance_id': 'a'},
        {'model_id': model_id, 'instance_id': 'b', 'offset_m': [20, 0, 0]},
    ], 'federate')
    planning.suggest_ifc_scenario('one', federation['model_id'], 'works', 'suggest')
    assert planning.run_scenario('one', 'works')['status'] == 'completed'
    assert original == source.read_bytes()
    source.write_bytes(original + b'\nChanged fixture\n')
    with pytest.raises(ValueError, match='fingerprint'):
        planning.run_scenario('one', 'works')
