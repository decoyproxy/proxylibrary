"""Read-only ontology health endpoint."""
from fastapi import APIRouter

import validator

router = APIRouter(prefix="/api/v1/ontology", tags=["ontology"])


@router.get("/health")
def ontology_health():
    return validator.scan()
