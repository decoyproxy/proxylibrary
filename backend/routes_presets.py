"""Local persistence for named galaxy views."""

import json
import threading

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

import ingest


router = APIRouter(prefix="/api/v1/presets", tags=["presets"])
PRESETS_FILE = ingest.DATA / "presets.json"
_presets = threading.Lock()


class Preset(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    state: dict

    @field_validator("name")
    @classmethod
    def clean_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("name must not be blank")
        if "/" in value:
            raise ValueError("name must not contain /")
        return value


def read_presets():
    if not PRESETS_FILE.exists():
        return {}
    try:
        payload = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
        presets = payload["presets"]
        if not isinstance(presets, dict):
            raise TypeError
        return presets
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise HTTPException(500, f"invalid preset store: {PRESETS_FILE}") from error


def write_presets(presets):
    PRESETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ingest.write_atomic(
        PRESETS_FILE,
        json.dumps({"presets": presets}, ensure_ascii=False, indent=2) + "\n",
    )


@router.get("")
def list_presets():
    with _presets:
        return {"presets": read_presets()}


@router.post("", status_code=201)
def save_preset(preset: Preset):
    with _presets:
        presets = read_presets()
        presets[preset.name] = preset.state
        write_presets(presets)
    return {"id": preset.name, "name": preset.name, "state": preset.state}


@router.delete("/{preset_id}")
def delete_preset(preset_id: str):
    with _presets:
        presets = read_presets()
        if preset_id not in presets:
            raise HTTPException(404, f"no preset {preset_id}")
        del presets[preset_id]
        write_presets(presets)
    return {"deleted": preset_id}
