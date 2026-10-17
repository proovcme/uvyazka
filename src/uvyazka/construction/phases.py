"""Pure phase selection shared by native and browser planning."""
def phase_context(model, selections=None):
    sources = model.get('phase_sources') or {'model': model.get('revit', {})}
    selections = selections or {}
    if not isinstance(selections, dict) or set(selections) - set(sources):
        raise ValueError('Неизвестная модель в выборе стадий Revit')
    contexts = {}
    for key, source in sources.items():
        phases = source.get('phases', [])
        order = {p['id']: p['order'] for p in phases if p.get('order') is not None}
        selected = selections.get(key)
        if selected is None and order:
            selected = max(order, key=order.get)
        if selected not in (None, 'all') and selected not in order:
            raise ValueError('Выбранная стадия не имеет подтверждённого порядка в исходной модели')
        contexts[key] = {'selected_id': selected, 'order': order,
            'source_status': source.get('status', 'unavailable')}
    return contexts


def phase_status(element, contexts):
    context = contexts.get(element.get('source_instance_id', 'model'), {})
    selected = context.get('selected_id')
    phases = context.get('order', {})
    data = element.get('revit', {})
    created, demolished = data.get('phase_created_id'), data.get('phase_demolished_id')
    if selected in (None, 'all') or data.get('phase_status') != 'read' or created not in phases:
        return 'unknown'
    rank = phases[selected]
    if phases[created] > rank:
        return 'future'
    if demolished is not None and demolished not in phases:
        return 'unknown'
    if demolished is not None and phases[demolished] < rank:
        return 'absent'
    if demolished == selected:
        return 'temporary' if created == selected else 'demolition'
    return 'new' if created == selected else 'existing'
