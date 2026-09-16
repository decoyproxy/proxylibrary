from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import store

app = FastAPI(title="proxylibrary")
app.add_middleware(
    CORSMiddleware, allow_origins=["http://localhost:5173"], allow_methods=["*"], allow_headers=["*"]
)


@app.get("/api/v1/nodes")
def nodes():
    return store.load()
