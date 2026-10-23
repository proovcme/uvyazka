"""Separate reproducible discrepancies, unresolved questions and unchecked work."""
from collections import Counter

CATEGORIES = ("discrepancy", "question", "unchecked")
UNCHECKED = {"document_not_reviewed", "discipline_not_reviewed", "entity_missing_in_discipline", "required_property_missing", "claim_value_missing"}
DISCREPANCIES = {"cross_discipline_difference", "project_requirement_not_met", "connection_parameter_difference",
                 "incompatible_port_kind", "connection_direction", "incompatible_internal_kind", "too_many_connections"}
CONNECTION_GAPS = {"required_connection_missing", "no_path_to_source"}


def classify_report(report, fresh=False):
    result = dict(report)
    coverage = report.get("coverage", {})
    complete = bool(coverage.get("expected_documents")) and not coverage.get("missing_documents") and not coverage.get("missing_disciplines") and not any(i["code"] == "scope_unconfirmed" for i in report["issues"])
    issues = []
    legacy = not fresh and report.get('classification_revision') != 1
    for original in report["issues"]:
        item = dict(original); code = item["code"]
        category = item.get("category") or ("unchecked" if code in UNCHECKED else "discrepancy" if code in DISCREPANCIES else "question")
        if category not in CATEGORIES:
            item['legacy_category'] = category
            category = 'question'
            item['classification_basis'] = 'unknown_category_requires_review'
        if legacy and code == 'cross_discipline_difference' and 'category' not in item:
            category = 'question'
            item['classification_basis'] = 'legacy_comparison_requires_reaudit'
        if code in CONNECTION_GAPS:
            category = "discrepancy" if complete else "unchecked"
        item.update(category=category, project_error_confirmed=False)
        item.setdefault("classification_basis", "declared_graph_only")
        issues.append(item)
    result["issues"] = issues
    counts = Counter(i["category"] for i in issues)
    result["finding_counts"] = {key: counts[key] for key in CATEGORIES}
    result["issue_count"] = len(issues)
    result['classification_revision'] = 0 if legacy else 1
    result['reaudit_recommended'] = legacy
    result["classification_note"] = "Число пунктов не является числом ошибок проекта. Расхождения проверены в переданных данных; вопросы и непроверенный объём учитываются отдельно."
    return result


def comparison_category(check):
    if check["status"] == "matches": return "match"
    if check["status"] == "needs_review": return "unchecked"
    if check["status"] == "question" and "difference" in check: return "discrepancy"
    return "question"
