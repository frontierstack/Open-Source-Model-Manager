"""
AIMem — AI Memory Compression Library

Reduces token usage when feeding context/memory to OpenAI-compatible APIs.

Winning strategy (100% fact retention at 47.8% token reduction):
  1. Semantic Deduplication — merge near-duplicate entries
  2. Lossy Prompt Compression — remove filler words/phrases
  3. Symbolic Shorthand — replace repeated phrases with short codes
  4. Relevance-Gated Retrieval — select top entries by query relevance

Usage:
    from compressor import MemoryCompressor, MemoryEntry

    entries = [
        MemoryEntry(content="...", source="chat_1", importance=0.9),
        MemoryEntry(content="...", source="docs", importance=1.0),
    ]

    compressor = MemoryCompressor(token_budget=1000)
    compressed = compressor.compress(entries, query="user's question")
    text = compressor.compress_to_text(entries, query="user's question")
"""

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional

import tiktoken
import numpy as np
from sklearn.cluster import AgglomerativeClustering
from sklearn.metrics.pairwise import cosine_similarity


# ---------------------------------------------------------------------------
# Token helpers
# ---------------------------------------------------------------------------

_ENC_CACHE: dict[str, tiktoken.Encoding] = {}


def _get_enc(model: str = "gpt-4o") -> tiktoken.Encoding:
    if model not in _ENC_CACHE:
        try:
            _ENC_CACHE[model] = tiktoken.encoding_for_model(model)
        except KeyError:
            _ENC_CACHE[model] = tiktoken.get_encoding("cl100k_base")
    return _ENC_CACHE[model]


def count_tokens(text: str, model: str = "gpt-4o") -> int:
    return len(_get_enc(model).encode(text))


def estimate_cost(prompt_tokens: int, completion_tokens: int, model: str = "gpt-4o") -> float:
    """Estimate cost in USD based on OpenAI pricing."""
    pricing = {
        "gpt-4o":       {"input": 2.50 / 1_000_000, "output": 10.00 / 1_000_000},
        "gpt-4o-mini":  {"input": 0.15 / 1_000_000, "output": 0.60 / 1_000_000},
        "gpt-4.1":      {"input": 2.00 / 1_000_000, "output": 8.00 / 1_000_000},
        "gpt-4.1-mini": {"input": 0.40 / 1_000_000, "output": 1.60 / 1_000_000},
        "gpt-4.1-nano": {"input": 0.10 / 1_000_000, "output": 0.40 / 1_000_000},
    }
    p = pricing.get(model, pricing["gpt-4o"])
    return prompt_tokens * p["input"] + completion_tokens * p["output"]


# ---------------------------------------------------------------------------
# Shared: TF-IDF vectorization
# ---------------------------------------------------------------------------

def _tfidf_vectors(texts: list[str]) -> np.ndarray:
    docs = [re.findall(r'\w+', t.lower()) for t in texts]
    vocab: dict[str, int] = {}
    for doc in docs:
        for w in set(doc):
            vocab.setdefault(w, len(vocab))

    n_docs, n_vocab = len(docs), len(vocab)
    if n_vocab == 0:
        return np.zeros((n_docs, 1))

    tf = np.zeros((n_docs, n_vocab))
    for i, doc in enumerate(docs):
        for w in doc:
            tf[i, vocab[w]] += 1
        if doc:
            tf[i] /= len(doc)

    df = np.sum(tf > 0, axis=0)
    idf = np.log((n_docs + 1) / (df + 1)) + 1
    tfidf = tf * idf
    norms = np.linalg.norm(tfidf, axis=1, keepdims=True)
    norms[norms == 0] = 1
    tfidf /= norms
    return tfidf


# ---------------------------------------------------------------------------
# Data structure
# ---------------------------------------------------------------------------

@dataclass
class MemoryEntry:
    """A single piece of memory / context."""
    content: str
    source: str = ""
    importance: float = 1.0
    _token_count: Optional[int] = field(default=None, repr=False)

    @property
    def tokens(self) -> int:
        if self._token_count is None:
            self._token_count = count_tokens(self.content)
        return self._token_count

    def _invalidate(self):
        self._token_count = None


# ---------------------------------------------------------------------------
# Strategy 1: Semantic Deduplication
# ---------------------------------------------------------------------------

class SemanticDeduplicator:
    """
    Clusters entries by TF-IDF cosine similarity. For each cluster of
    near-duplicates, merges unique sentences into a single entry.
    """

    def __init__(self, similarity_threshold: float = 0.45):
        self.similarity_threshold = similarity_threshold

    @staticmethod
    def _merge_texts(texts: list[str]) -> str:
        """Keep the most complete version of each distinct fact."""
        # Collect all sentences with their word sets
        all_sents: list[tuple[str, set[str]]] = []
        for text in texts:
            for sent in re.split(r'(?<=[.!?])\s+', text.strip()):
                sent = sent.strip()
                if len(sent) > 5:
                    all_sents.append((sent, set(re.findall(r'\w+', sent.lower()))))

        # Greedily pick sentences, skipping those whose content is already
        # covered by a previously-accepted (longer) sentence.
        # Sort longest first so the most complete version wins.
        all_sents.sort(key=lambda x: len(x[1]), reverse=True)

        kept: list[tuple[str, set[str]]] = []
        for sent, words in all_sents:
            if not words:
                continue
            # Check if this sentence's content is already mostly covered
            is_covered = False
            for _, kept_words in kept:
                overlap = len(words & kept_words) / len(words)
                if overlap > 0.65:
                    is_covered = True
                    break
            if not is_covered:
                kept.append((sent, words))

        # Return in a stable order (by first appearance in original texts)
        combined = " ".join(t for t in texts)
        kept.sort(key=lambda x: combined.find(x[0]))
        return " ".join(s for s, _ in kept)

    def run(self, entries: list[MemoryEntry]) -> list[MemoryEntry]:
        if len(entries) <= 1:
            return entries

        vectors = _tfidf_vectors([e.content for e in entries])
        distance = np.clip(1.0 - cosine_similarity(vectors), 0, None)
        np.fill_diagonal(distance, 0)

        labels = AgglomerativeClustering(
            n_clusters=None,
            distance_threshold=1.0 - self.similarity_threshold,
            metric="precomputed",
            linkage="average",
        ).fit_predict(distance)

        clusters: dict[int, list[int]] = {}
        for idx, label in enumerate(labels):
            clusters.setdefault(label, []).append(idx)

        result = []
        for indices in clusters.values():
            if len(indices) == 1:
                result.append(entries[indices[0]])
            else:
                merged = MemoryEntry(
                    content=self._merge_texts([entries[i].content for i in indices]),
                    source=entries[max(indices, key=lambda i: entries[i].importance)].source,
                    importance=min(1.0, max(entries[i].importance for i in indices) * 1.1),
                )
                result.append(merged)
        return result


# ---------------------------------------------------------------------------
# Strategy 2: Lossy Prompt Compression
# ---------------------------------------------------------------------------

class LossyCompressor:
    """
    Word/phrase-level compression inspired by LLMLingua research.
    Removes filler words, applies contractions, simplifies verbose
    constructions — without removing whole sentences.
    """

    REMOVE_WORDS = frozenset([
        "very", "really", "quite", "rather", "somewhat", "fairly",
        "basically", "essentially", "actually", "literally",
        "certainly", "definitely", "obviously", "clearly",
        "generally", "typically", "usually", "normally",
        "additionally", "furthermore", "moreover",
        "however", "nevertheless", "nonetheless",
        "approximately", "roughly",
        "specifically", "particularly", "especially",
        "respective", "respectively",
        "aforementioned", "abovementioned",
    ])

    CONTRACTIONS = [
        (r'\bdo not\b', "don't"), (r'\bdoes not\b', "doesn't"),
        (r'\bwill not\b', "won't"), (r'\bcannot\b', "can't"),
        (r'\bcan not\b', "can't"), (r'\bshould not\b', "shouldn't"),
        (r'\bwould not\b', "wouldn't"), (r'\bcould not\b', "couldn't"),
        (r'\bis not\b', "isn't"), (r'\bare not\b', "aren't"),
        (r'\bwas not\b', "wasn't"), (r'\bwere not\b', "weren't"),
        (r'\bhas not\b', "hasn't"), (r'\bhave not\b', "haven't"),
        (r'\bhad not\b', "hadn't"), (r'\bit is\b', "it's"),
        (r'\bthat is\b', "that's"), (r'\bthere is\b', "there's"),
    ]

    SIMPLIFICATIONS = [
        (r'\bin order to\b', 'to'),
        (r'\bdue to the fact that\b', 'because'),
        (r'\bfor the purpose of\b', 'for'),
        (r'\bin the event that\b', 'if'),
        (r'\bat the present time\b', 'now'),
        (r'\bat this point in time\b', 'now'),
        (r'\bon a regular basis\b', 'regularly'),
        (r'\bon a daily basis\b', 'daily'),
        (r'\ba large number of\b', 'many'),
        (r'\ba small number of\b', 'few'),
        (r'\bthe majority of\b', 'most'),
        (r'\bin close proximity to\b', 'near'),
        (r'\bwith regard to\b', 'about'),
        (r'\bwith respect to\b', 'about'),
        (r'\bin the process of\b', 'while'),
        (r'\bis able to\b', 'can'),
        (r'\bare able to\b', 'can'),
        (r'\bwas able to\b', 'could'),
        (r'\bprior to\b', 'before'),
        (r'\bsubsequent to\b', 'after'),
        (r'\bin spite of\b', 'despite'),
        (r'\bas a result of\b', 'from'),
        (r'\ba total of\b', ''),
    ]

    def run(self, text: str) -> str:
        result = text
        for pattern, repl in self.SIMPLIFICATIONS:
            result = re.sub(pattern, repl, result, flags=re.IGNORECASE)
        for pattern, repl in self.CONTRACTIONS:
            result = re.sub(pattern, repl, result, flags=re.IGNORECASE)

        words = result.split()
        result = ' '.join(
            w for w in words
            if re.sub(r'[^a-zA-Z]', '', w).lower() not in self.REMOVE_WORDS
        )
        result = re.sub(
            r'\bthe (\w+(?:\s+\w+)?)\s+(?:service|system|application|project|database|table|server)\b',
            r'\1', result, flags=re.IGNORECASE,
        )
        return re.sub(r'\s{2,}', ' ', result).strip()


# ---------------------------------------------------------------------------
# Strategy 3: Symbolic Shorthand / Codebook
# ---------------------------------------------------------------------------

class SymbolicShorthand:
    """
    Identifies frequently repeated multi-word phrases across all entries
    and replaces them with short symbolic codes. Prepends a legend.
    """

    def __init__(self, min_freq: int = 3, min_words: int = 2, max_words: int = 5):
        self.min_freq = min_freq
        self.min_words = min_words
        self.max_words = max_words

    def _build_codebook(self, texts: list[str]) -> dict[str, str]:
        combined = ' '.join(texts)
        counts: Counter = Counter()
        for n in range(self.min_words, self.max_words + 1):
            words = combined.split()
            for i in range(len(words) - n + 1):
                gram = ' '.join(words[i:i + n])
                if any(c.isalpha() for c in gram):
                    counts[gram.lower()] += 1

        candidates = []
        for phrase, count in counts.items():
            if count < self.min_freq:
                continue
            phrase_tokens = count_tokens(phrase)
            if phrase_tokens < 2:
                continue
            # Net savings: (original tokens) - (code tokens + legend entry)
            savings = (phrase_tokens * count) - (count + phrase_tokens + 3)
            if savings < 3:
                continue
            if savings > 0:
                candidates.append((savings, phrase, count))
        candidates.sort(reverse=True)

        codebook: dict[str, str] = {}
        used: list[str] = []
        idx = 0
        for savings, phrase, count in candidates[:20]:
            if any(phrase in u or u in phrase for u in used):
                continue
            initials = ''.join(w[0] for w in phrase.split() if w[0].isalpha()).upper()
            code = f"${initials or f'X{idx}'}"
            while code in codebook.values():
                idx += 1
                code = f"${initials}{idx}"
            codebook[phrase] = code
            used.append(phrase)
            idx += 1
        return codebook

    def run(self, entries: list[MemoryEntry]) -> list[MemoryEntry]:
        codebook = self._build_codebook([e.content for e in entries])
        if not codebook:
            return entries

        result = []
        for entry in entries:
            new_content = entry.content
            for phrase, code in codebook.items():
                new_content = re.sub(re.escape(phrase), code, new_content, flags=re.IGNORECASE)
            result.append(MemoryEntry(
                content=new_content, source=entry.source, importance=entry.importance,
            ))

        legend = "[" + ", ".join(f"{c}={p}" for p, c in codebook.items()) + "]\n"
        result[0].content = legend + result[0].content
        result[0]._invalidate()
        return result


# ---------------------------------------------------------------------------
# Strategy 4: Relevance-Gated Retrieval
# ---------------------------------------------------------------------------

class RelevanceGate:
    """
    Ranks entries by TF-IDF similarity to the query (weighted by
    importance), then greedily fills a token budget with the top entries.
    """

    def __init__(self, token_budget: int = 1000):
        self.token_budget = token_budget

    def run(self, query: str, entries: list[MemoryEntry]) -> list[MemoryEntry]:
        if not entries:
            return []

        vectors = _tfidf_vectors([query] + [e.content for e in entries])
        sims = cosine_similarity(vectors[0:1], vectors[1:])[0]

        scored = sorted(
            ((float(sims[i]) * e.importance, e) for i, e in enumerate(entries)),
            key=lambda x: x[0], reverse=True,
        )

        result, used = [], 0
        for _, entry in scored:
            if used + entry.tokens <= self.token_budget:
                result.append(entry)
                used += entry.tokens
        return result


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class MemoryCompressor:
    """
    Compression pipeline: Dedup → Lossy → Shorthand → Relevance Gate.

    Args:
        dedup_threshold: Cosine similarity threshold for merging entries (0-1).
            Lower = more aggressive merging. Default 0.45.
        token_budget: Maximum tokens in the compressed output.
            Default 1000.
    """

    def __init__(
        self,
        dedup_threshold: float = 0.45,
        token_budget: int = 1000,
    ):
        self.dedup = SemanticDeduplicator(similarity_threshold=dedup_threshold)
        self.lossy = LossyCompressor()
        self.shorthand = SymbolicShorthand()
        self.gate = RelevanceGate(token_budget=token_budget)

    def compress(
        self,
        entries: list[MemoryEntry],
        query: Optional[str] = None,
    ) -> list[MemoryEntry]:
        """Run the full compression pipeline."""
        result = list(entries)

        # 1. Merge near-duplicate entries
        result = self.dedup.run(result)

        # 2. Word/phrase-level lossy compression
        for e in result:
            e.content = self.lossy.run(e.content)
            e._invalidate()

        # 3. Replace repeated phrases with short codes
        result = self.shorthand.run(result)
        for e in result:
            e._invalidate()

        # 4. Select most relevant entries within token budget
        if query:
            result = self.gate.run(query, result)

        return result

    def compress_to_text(
        self,
        entries: list[MemoryEntry],
        query: Optional[str] = None,
        separator: str = "\n---\n",
    ) -> str:
        """Compress and return as a single string ready for prompt injection."""
        return separator.join(e.content for e in self.compress(entries, query))

    def stats(
        self,
        original_entries: list[MemoryEntry],
        compressed_entries: list[MemoryEntry],
        model: str = "gpt-4o",
    ) -> dict:
        """Token and cost statistics comparing original vs. compressed."""
        orig_tokens = sum(e.tokens for e in original_entries)
        comp_tokens = sum(count_tokens(e.content) for e in compressed_entries)
        reduction = orig_tokens - comp_tokens
        pct = (reduction / orig_tokens * 100) if orig_tokens > 0 else 0
        completion = 200
        orig_cost = estimate_cost(orig_tokens, completion, model)
        comp_cost = estimate_cost(comp_tokens, completion, model)
        return {
            "original_entries": len(original_entries),
            "compressed_entries": len(compressed_entries),
            "original_tokens": orig_tokens,
            "compressed_tokens": comp_tokens,
            "tokens_saved": reduction,
            "reduction_pct": round(pct, 1),
            "original_cost_per_call": round(orig_cost, 6),
            "compressed_cost_per_call": round(comp_cost, 6),
            "savings_per_1k_calls": round((orig_cost - comp_cost) * 1000, 4),
        }
