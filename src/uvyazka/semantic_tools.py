"""Optional retrieval, shared with the local panel; engineering reasoning stays with the caller."""
from .semantic_search import SemanticSearch


def register_tools(mcp,workspace):
    @mcp.tool(annotations={'readOnlyHint':True,'idempotentHint':True})
    def get_semantic_search_status(project_id: str) -> dict:
        """Read optional local embedding configuration and prepared-index coverage without starting a model.
        Registered versions only; this is not proof that every original or drawing region was read.
        Configuration is set locally through the CLI, not from document content or tool arguments."""
        return SemanticSearch(workspace,project_id).status()

    @mcp.tool(annotations={'readOnlyHint':False,'destructiveHint':False,'idempotentHint':True})
    def build_semantic_index(project_id: str,limit: int=24,doc_ids: list[str] | None=None,retry_failed: bool=False) -> dict:
        """Prepare/reuse local embeddings from cached literal text and explicitly saved drawing views.
        Requires a locally configured DigUp-compatible worker and weights. No model API, no uploads.
        Processes 1–64 segments per call, preserving progress in the same project SQLite.
        Repeat while pending remains. View images use their exact registered region/revision; they are not OCR.
        Cached text includes numerical fragments; no automatic project interpretation or accepted facts.
        Changed source hashes/view revisions are excluded; refresh the source before retrying failures."""
        return SemanticSearch(workspace,project_id).build(limit,doc_ids,retry_failed)

    @mcp.tool(annotations={'readOnlyHint':True,'idempotentHint':True})
    def search_project_memory(project_id: str,query: str,mode: str='hybrid',limit: int=10,
                              doc_id: str | None=None,min_similarity: float=0.72) -> dict:
        """Retrieve multiple addressed fragments per document: literal, semantic or hybrid.
        Local optional embedding worker; explicit fallback to literal if unavailable/unprepared/incompatible.
        Returns actual-hash-verified source/page-or-block locators and similarity as a ranking diagnostic,
        never confidence in engineering correctness. Numbered single-token IDs use exact lexical terms.
        Images cover only explicitly saved views, not all scans. No absence/full-review claim from empty results.
        min_similarity is a provisional retrieval cutoff, not a probability, tolerance or engineering decision."""
        return SemanticSearch(workspace,project_id).search(query,mode,limit,doc_id,min_similarity)
