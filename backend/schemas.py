"""Pydantic request/response schemas for the API."""
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    created_at: datetime


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    username: str


# ---------------------------------------------------------------------------
# Trees
# ---------------------------------------------------------------------------
class TreeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None


class TreeUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


class TreeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Individuals
# ---------------------------------------------------------------------------
class IndividualBase(BaseModel):
    given_name: str | None = None
    middle_name: str | None = None
    surname: str | None = None
    sex: str | None = Field(default=None, pattern="^[MFU]$")
    birth_date: str | None = None
    birth_place: str | None = None
    death_date: str | None = None
    death_place: str | None = None
    age: str | None = None
    notes: str | None = None
    photo_url: str | None = None


class IndividualCreate(IndividualBase):
    is_unknown: bool = False


class IndividualUpdate(IndividualBase):
    pass


class IndividualOut(IndividualBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tree_id: uuid.UUID
    gedcom_xref: str | None
    is_unknown: bool
    created_at: datetime
    updated_at: datetime


# ---------------------------------------------------------------------------
# Families
# ---------------------------------------------------------------------------
class MergeRequest(BaseModel):
    duplicate_id: uuid.UUID  # the record to merge INTO the survivor (path id)


class DuplicatePairRequest(BaseModel):
    id_a: uuid.UUID
    id_b: uuid.UUID


class WarningKeyRequest(BaseModel):
    key: str = Field(min_length=1, max_length=512)


class DismissedPairOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    individual_a: uuid.UUID
    individual_b: uuid.UUID


class ChildRef(BaseModel):
    individual_id: uuid.UUID
    birth_order: int | None = None
    relation: str = "biological"  # biological | adopted | step | foster


class FamilyBase(BaseModel):
    husband_id: uuid.UUID | None = None
    wife_id: uuid.UUID | None = None
    married_date: str | None = None
    married_place: str | None = None
    divorced_date: str | None = None
    notes: str | None = None
    marriage_order: int | None = None
    # "Unknown-depth descendant" link (rendered dotted).
    gap: bool = False
    # Known co-parents who are not married (dotted, no marriage symbol).
    unmarried: bool = False


class FamilyCreate(FamilyBase):
    children: list[ChildRef] = Field(default_factory=list)


class FamilyUpdate(FamilyBase):
    children: list[ChildRef] | None = None


class ChildOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    individual_id: uuid.UUID
    birth_order: int | None
    relation: str = "biological"


class FamilyOut(FamilyBase):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    tree_id: uuid.UUID
    gedcom_xref: str | None
    children: list[ChildOut]


# ---------------------------------------------------------------------------
# GEDCOM
# ---------------------------------------------------------------------------
class ImportSummary(BaseModel):
    individuals_imported: int
    families_imported: int
    children_links: int
    sources_imported: int
    unknown_spouses_created: int
    warnings: list[str]


# ---------------------------------------------------------------------------
# Visualization (recursive descendant / ancestor trees)
# ---------------------------------------------------------------------------
class TreeNode(BaseModel):
    """Ancestor-chart node. `children` holds the next generation outward (parents)."""

    id: uuid.UUID
    given_name: str | None
    middle_name: str | None
    surname: str | None
    sex: str | None
    birth_date: str | None
    death_date: str | None
    age: str | None
    is_unknown: bool
    generation: int
    photo_url: str | None = None
    children: list["TreeNode"] = Field(default_factory=list)


class DescendantNode(BaseModel):
    """Descendant-chart node, modeled as a person plus their marriage `unions`.

    Each union carries the co-parent (`spouse`) and the `children` of that union.
    A spouse is itself a DescendantNode whose `unions` are that spouse's OTHER
    marriages — this is how converging family lines (e.g. a widow's remarriage)
    are surfaced. Recursion is de-duplicated server-side to avoid cycles.
    """

    id: uuid.UUID
    given_name: str | None
    middle_name: str | None
    surname: str | None
    sex: str | None
    birth_date: str | None
    death_date: str | None
    age: str | None
    is_unknown: bool
    generation: int
    photo_url: str | None = None
    # How this person relates to their parents in this chart (biological by
    # default; adopted/step/foster for non-biological child links).
    relation: str = "biological"
    unions: list["DescendantUnion"] = Field(default_factory=list)


class DescendantUnion(BaseModel):
    spouse: "DescendantNode | None" = None
    children: list["DescendantNode"] = Field(default_factory=list)
    # 1-based position of this marriage for the person (1st, 2nd, 3rd spouse).
    ordinal: int = 1
    # TRUE when this is an "unknown-depth descendant" link (rendered dotted).
    gap: bool = False
    # TRUE when the co-parents are not married (dotted, no marriage symbol).
    unmarried: bool = False
    # TRUE when the marriage ended in divorce (rendered with the divorce symbol ⚮).
    divorced: bool = False
