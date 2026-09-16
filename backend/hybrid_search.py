"""Small BM25 + OpenCLIP search over the vectors written by ingest.py."""

import math
import re
from collections import Counter

import ingest


TOKEN = re.compile(r"[^\W_]+", re.UNICODE)


def tokens(text):
    return TOKEN.findall(text.casefold())


def bm25(query, documents, k1=1.5, b=0.75):
    """Return BM25 scores normalized to 0..1 for easy score blending."""
    words = tokens(query)
    corpus = [tokens(document) for document in documents]
    if not words or not corpus:
        return [0.0] * len(corpus)
    average = sum(map(len, corpus)) / len(corpus) or 1
    frequencies = [Counter(document) for document in corpus]
    scores = [0.0] * len(corpus)
    for word in set(words):
        matches = sum(word in frequency for frequency in frequencies)
        inverse_frequency = math.log(1 + (len(corpus) - matches + 0.5) / (matches + 0.5))
        for index, frequency in enumerate(frequencies):
            count = frequency[word]
            if count:
                denominator = count + k1 * (1 - b + b * len(corpus[index]) / average)
                scores[index] += inverse_frequency * count * (k1 + 1) / denominator
    maximum = max(scores, default=0)
    return [score / maximum if maximum else 0.0 for score in scores]


def rank(query, records, clip_scores, limit=8):
    """Blend lexical and CLIP scores, with explicit phrase/title boosts."""
    searchable = [f"{record['title']} {record['title']} {record['document']}" for record in records]
    keyword_scores = bm25(query, searchable)
    needle = query.casefold().strip()
    ranked = []
    for record, keyword_score, text in zip(records, keyword_scores, searchable):
        phrase = bool(needle and needle in text.casefold())
        title = needle == record["title"].casefold().strip()
        clip_score = max(0.0, min(1.0, clip_scores.get(record["id"], 0.0)))
        score = 0.5 * clip_score + 0.4 * keyword_score + 0.1 * phrase + 0.15 * title
        meta = record["metadata"]
        ranked.append({
            "id": record["id"],
            "title": record["title"],
            "type": meta.get("type"),
            "path": meta.get("path"),
            "media": meta.get("media"),
            "score": round(score, 4),
            "keyword_score": round(keyword_score, 4),
            "clip_score": round(clip_score, 4),
            "exact_match": phrase,
        })
    return sorted(ranked, key=lambda item: (-item["score"], item["id"]))[:limit]


def search(query, limit=8, text_store=None):
    """Search the canonical ingested text and its matching CLIP collection."""
    query = query.strip()
    limit = max(1, min(limit, 50))
    if not query:
        return {"query": query, "results": []}

    text_store = text_store or ingest.collection()
    stored = text_store.get(include=["documents", "metadatas"])
    records = [
        {
            "id": node_id,
            "title": metadata.get("title", node_id),
            "document": document or "",
            "metadata": metadata,
        }
        for node_id, document, metadata in zip(
            stored["ids"], stored["documents"], stored["metadatas"]
        )
    ]
    if not records:
        return {"query": query, "results": []}

    clip_store = ingest.clip_collection()
    found = clip_store.query(
        query_embeddings=ingest.embed_image_query(query),
        n_results=min(len(records), clip_store.count()),
    ) if clip_store.count() else {"ids": [[]], "distances": [[]]}
    clip_scores = {
        node_id: 1 - distance
        for node_id, distance in zip(found["ids"][0], found["distances"][0])
    }
    return {"query": query, "results": rank(query, records, clip_scores, limit)}
