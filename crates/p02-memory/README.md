# p02-memory

The embedded memory engine: the slice of mem0 the mem0 plugin's embedded
backend uses, written for this daemon. It depends on p02-shared alone, and
reaches the disk only through the SQLite connection its caller opens.

- **Extraction.** A captured turn costs one call to an OpenAI-wire model:
  mem0ai 3.1.6's additive extraction prompt, verbatim and frozen, with
  mem0's user message (the session's last ten messages, each cut at 300
  characters, the ten memories nearest to the turn, and the turn's day as
  both dates), asked for a JSON object. The answer is read as mem0 reads
  it, past special tokens, code fences and `<think>` blocks; an answer
  with no `memory` list is unreadable, never an extraction of nothing.
- **Storage.** Memories belong to a person and a character, each text
  once between them across every session. A capture commits its memories,
  their vectors and the turn's messages (the last ten per session are
  kept) in one transaction; a failure, a locked database among them,
  stores nothing and says why.
- **Embedders.** The store records its embedder, model and endpoint, as
  a generation, with the width learned from its first vector; every
  vector carries its generation, and a search reads only the current
  one's. A different embedder replaces the generation and drops its
  vectors in one transaction, after which every memory is re-embedded,
  one request each, oldest first and each committed as it comes, so a
  crash or yet another embedder resumes the work instead of repeating it.
  An engine still holding a replaced generation writes no vector.
- **Recall** ranks a person and character's memories by cosine similarity
  to the query and keeps those at least 0.1 alike; the score is the
  cosine.
- **Readiness.** The engine says whether the model and the embedder each
  last answered something usable since it opened, and how many memories
  wait for a vector; writes run one at a time.

## Live check

An ignored test sends the extraction prompt, for one fixed turn full of
facts, to the OpenAI-wire model the environment names, prints the answer
and the memories read from it, and fails when the answer holds no memory
list or the list is empty. Against a local Ollama serving a small model:

```sh
ollama pull qwen2.5:3b
P02_LIVE_BASE_URL=http://127.0.0.1:11434/v1 P02_LIVE_MODEL=qwen2.5:3b \
  cargo test -p p02-memory --lib -- --ignored --nocapture live_check
```

`P02_LIVE_API_KEY` carries a key for an endpoint that takes one.

Not run yet: no model server answered on the loopback interface of the
machine the engine was written on. A run records its model and result
here.

## Third-party material

`third_party/mem0/additive_extraction_prompt.txt` is mem0ai 3.1.6's
`ADDITIVE_EXTRACTION_PROMPT`, copied unmodified from the package's bundle:
Copyright 2023 Taranjeet Singh, from <https://github.com/mem0ai/mem0>,
under the Apache License, Version 2.0, whose text is
`third_party/mem0/LICENSE`.
