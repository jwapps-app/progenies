"""Photos-out-of-the-chart and header-token share-link tests.

Covers the batched photos endpoint (authenticated and public), the move of the
share token from the URL path to the X-Share-Token header, and the slimmer
individuals list (notes omitted unless asked for).
"""
import uuid

PHOTO = "data:image/jpeg;base64,QUJD"


def _mk_tree(client, headers, name):
    r = client.post("/api/trees", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _mk_person(client, headers, tree, **fields):
    r = client.post(f"/api/trees/{tree}/individuals", headers=headers, json=fields)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _share_headers(token):
    return {"X-Share-Token": token}


def _viewer_headers(client, admin, tree, username):
    """A fresh read-only collaborator on `tree`, returning their auth headers."""
    r = client.post("/api/users", headers=admin, json={"username": username, "password": "password123"})
    assert r.status_code == 201, r.text
    r = client.put(
        f"/api/trees/{tree}/shares", headers=admin, json={"user_id": r.json()["id"], "role": "viewer"}
    )
    assert r.status_code == 200, r.text
    tok = client.post("/auth/login", json={"username": username, "password": "password123"}).json()[
        "access_token"
    ]
    return {"Authorization": f"Bearer {tok}"}


# ---------------------------------------------------------------------------
# Batched photos (authenticated)
# ---------------------------------------------------------------------------
def test_photos_batch_returns_only_ids_with_photos_in_this_tree(client, admin):
    tree = _mk_tree(client, admin, "Photos")
    other = _mk_tree(client, admin, "PhotosOther")
    with_photo = _mk_person(client, admin, tree, given_name="Pic", photo_url=PHOTO)
    without = _mk_person(client, admin, tree, given_name="NoPic")
    foreign = _mk_person(client, admin, other, given_name="Elsewhere", photo_url=PHOTO)
    unknown = str(uuid.uuid4())

    r = client.post(
        f"/api/trees/{tree}/photos",
        headers=admin,
        json={"ids": [with_photo, without, foreign, unknown, with_photo]},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {with_photo: PHOTO}
    assert r.headers["cache-control"] == "private, max-age=300"

    # Empty batch is fine and empty.
    r = client.post(f"/api/trees/{tree}/photos", headers=admin, json={"ids": []})
    assert r.status_code == 200 and r.json() == {}


def test_photos_batch_caps_at_2000_ids(client, admin):
    tree = _mk_tree(client, admin, "PhotosCap")
    ids = [str(uuid.uuid4()) for _ in range(2000)]
    assert client.post(f"/api/trees/{tree}/photos", headers=admin, json={"ids": ids}).status_code == 200
    r = client.post(f"/api/trees/{tree}/photos", headers=admin, json={"ids": ids + [str(uuid.uuid4())]})
    assert r.status_code == 422


def test_photos_batch_access(client, admin):
    tree = _mk_tree(client, admin, "PhotosAccess")
    pid = _mk_person(client, admin, tree, given_name="Pic", photo_url=PHOTO)
    viewer = _viewer_headers(client, admin, tree, "photo_viewer")

    assert client.post(f"/api/trees/{tree}/photos", json={"ids": [pid]}).status_code == 401
    r = client.post(f"/api/trees/{tree}/photos", headers=viewer, json={"ids": [pid]})
    assert r.status_code == 200 and r.json() == {pid: PHOTO}


# ---------------------------------------------------------------------------
# Chart payloads carry no photos
# ---------------------------------------------------------------------------
def test_chart_nodes_have_no_photo_key(client, admin):
    tree = _mk_tree(client, admin, "ChartNoPhoto")
    dad = _mk_person(client, admin, tree, given_name="Dad", photo_url=PHOTO)
    kid = _mk_person(client, admin, tree, given_name="Kid", photo_url=PHOTO)
    r = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={"husband_id": dad, "children": [{"individual_id": kid}]},
    )
    assert r.status_code == 201, r.text

    def _walk(node):
        yield node
        for u in node.get("unions", []):
            if u.get("spouse"):
                yield from _walk(u["spouse"])
            for c in u.get("children", []):
                yield from _walk(c)
        for c in node.get("children", []) if "unions" not in node else []:
            yield from _walk(c)

    desc = client.get(f"/api/trees/{tree}/descendants/{dad}", headers=admin).json()
    seen = list(_walk(desc))
    assert {n["id"] for n in seen} == {dad, kid}
    for n in seen:
        assert "photo_url" not in n or n["photo_url"] is None
    anc = client.get(f"/api/trees/{tree}/ancestors/{kid}", headers=admin).json()
    for n in _walk(anc):
        assert "photo_url" not in n or n["photo_url"] is None


# ---------------------------------------------------------------------------
# Share link: header token
# ---------------------------------------------------------------------------
def test_public_routes_take_token_from_header(client, admin):
    tree = _mk_tree(client, admin, "PublicHeader")
    dad = _mk_person(client, admin, tree, given_name="Dad", photo_url=PHOTO, notes="PRIVATE")
    kid = _mk_person(client, admin, tree, given_name="Kid")
    r = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={"husband_id": dad, "children": [{"individual_id": kid}]},
    )
    assert r.status_code == 201, r.text
    token = client.post(f"/api/trees/{tree}/share-link", headers=admin).json()["share_token"]
    assert token
    hdr = _share_headers(token)

    r = client.get("/public/tree", headers=hdr)
    assert r.status_code == 200 and r.json()["name"] == "PublicHeader"
    people = client.get("/public/individuals", headers=hdr).json()
    assert {p["id"] for p in people} == {dad, kid}
    fams = client.get("/public/families", headers=hdr).json()
    assert len(fams) == 1
    desc = client.get(f"/public/descendants/{dad}", headers=hdr)
    assert desc.status_code == 200 and desc.json()["id"] == dad
    anc = client.get(f"/public/ancestors/{kid}", headers=hdr)
    assert anc.status_code == 200 and anc.json()["id"] == kid

    # No header at all → 401 (not the "revoked" 404), with a clear reason.
    r = client.get("/public/tree")
    assert r.status_code == 401
    assert "X-Share-Token" in r.json()["detail"]
    # Wrong token → 404, existence stays hidden.
    assert client.get("/public/tree", headers=_share_headers("nope")).status_code == 404
    # The old path form is gone — no route, no token in any access log.
    assert client.get(f"/public/{token}/tree").status_code == 404
    assert client.get(f"/public/{token}/individuals").status_code == 404

    # Revoking the link closes the door.
    client.delete(f"/api/trees/{tree}/share-link", headers=admin)
    assert client.get("/public/tree", headers=hdr).status_code == 404


def test_public_chart_nodes_have_no_photos_and_public_list_stays_slim(client, admin):
    tree = _mk_tree(client, admin, "PublicSlim")
    dad = _mk_person(
        client,
        admin,
        tree,
        given_name="Dad",
        photo_url=PHOTO,
        notes="PRIVATE NOTE",
        birth_place="Hidden Village",
        gedcom_xref="@I9@",
    )
    kid = _mk_person(client, admin, tree, given_name="Kid", photo_url=PHOTO)
    r = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={"husband_id": dad, "children": [{"individual_id": kid}]},
    )
    assert r.status_code == 201, r.text
    token = client.post(f"/api/trees/{tree}/share-link", headers=admin).json()["share_token"]
    hdr = _share_headers(token)

    desc = client.get(f"/public/descendants/{dad}", headers=hdr).json()
    assert "photo_url" not in desc or desc["photo_url"] is None
    child = desc["unions"][0]["children"][0]
    assert child["id"] == kid
    assert "photo_url" not in child or child["photo_url"] is None
    anc = client.get(f"/public/ancestors/{kid}", headers=hdr).json()
    assert "photo_url" not in anc or anc["photo_url"] is None
    assert "photo_url" not in anc["children"][0] or anc["children"][0]["photo_url"] is None

    people = client.get("/public/individuals", headers=hdr).json()
    assert people
    for p in people:
        for leaked in ("notes", "birth_place", "death_place", "gedcom_xref", "photo_url", "tree_id", "created_at"):
            assert leaked not in p, f"public individual leaked {leaked}"

    client.delete(f"/api/trees/{tree}/share-link", headers=admin)


def test_public_photos_scoped_to_shared_tree(client, admin):
    tree = _mk_tree(client, admin, "PublicPhotos")
    other = _mk_tree(client, admin, "PublicPhotosOther")
    pic = _mk_person(client, admin, tree, given_name="Pic", photo_url=PHOTO)
    nopic = _mk_person(client, admin, tree, given_name="NoPic")
    foreign = _mk_person(client, admin, other, given_name="Elsewhere", photo_url=PHOTO)
    token = client.post(f"/api/trees/{tree}/share-link", headers=admin).json()["share_token"]
    hdr = _share_headers(token)

    r = client.post("/public/photos", headers=hdr, json={"ids": [pic, nopic, foreign]})
    assert r.status_code == 200, r.text
    assert r.json() == {pic: PHOTO}
    assert r.headers["cache-control"] == "private, max-age=300"

    assert client.post("/public/photos", json={"ids": [pic]}).status_code == 401
    r = client.post("/public/photos", headers=hdr, json={"ids": [str(uuid.uuid4()) for _ in range(2001)]})
    assert r.status_code == 422

    client.delete(f"/api/trees/{tree}/share-link", headers=admin)
    assert client.post("/public/photos", headers=hdr, json={"ids": [pic]}).status_code == 404


# ---------------------------------------------------------------------------
# Individuals list omits notes (and photos) unless asked
# ---------------------------------------------------------------------------
def test_list_individuals_omits_notes_and_photos_by_default(client, admin):
    tree = _mk_tree(client, admin, "ListSlim")
    pid = _mk_person(
        client,
        admin,
        tree,
        given_name="Noted",
        notes="Long story",
        birth_place="Here",
        death_place="There",
        photo_url=PHOTO,
    )

    people = client.get(f"/api/trees/{tree}/individuals", headers=admin).json()
    assert [p["id"] for p in people] == [pid]
    p = people[0]
    assert "notes" not in p and "photo_url" not in p
    # Places stay on the list — the search box and duplicate summaries read them.
    assert p["birth_place"] == "Here" and p["death_place"] == "There"

    p = client.get(f"/api/trees/{tree}/individuals?include_details=true", headers=admin).json()[0]
    assert p["notes"] == "Long story" and "photo_url" not in p
    p = client.get(f"/api/trees/{tree}/individuals?include_photos=true", headers=admin).json()[0]
    assert p["photo_url"] == PHOTO and "notes" not in p
    p = client.get(
        f"/api/trees/{tree}/individuals?include_photos=true&include_details=true", headers=admin
    ).json()[0]
    assert p["photo_url"] == PHOTO and p["notes"] == "Long story"
    # The detail route is always complete.
    d = client.get(f"/api/trees/{tree}/individuals/{pid}", headers=admin).json()
    assert d["notes"] == "Long story" and d["photo_url"] == PHOTO


# ---------------------------------------------------------------------------
# Merge re-points citations in bulk
# ---------------------------------------------------------------------------
def test_merge_repoints_citations_and_child_links(client, admin):
    tree = _mk_tree(client, admin, "MergeBulk")
    keep = _mk_person(client, admin, tree, given_name="Keep")
    dup = _mk_person(client, admin, tree, given_name="Dup", notes="from dup")
    parent = _mk_person(client, admin, tree, given_name="Parent")
    r = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={"husband_id": parent, "children": [{"individual_id": dup, "birth_order": 2}]},
    )
    assert r.status_code == 201, r.text
    fam_id = r.json()["id"]
    src = client.post(f"/api/trees/{tree}/sources", headers=admin, json={"title": "Register"})
    assert src.status_code == 201, src.text
    for page in ("p. 1", "p. 2"):
        r = client.post(
            f"/api/trees/{tree}/individuals/{dup}/citations",
            headers=admin,
            json={"source_id": src.json()["id"], "page": page},
        )
        assert r.status_code == 201, r.text

    r = client.post(f"/api/trees/{tree}/individuals/{keep}/merge", headers=admin, json={"duplicate_id": dup})
    assert r.status_code == 204, r.text

    cits = client.get(f"/api/trees/{tree}/individuals/{keep}/citations", headers=admin).json()
    assert sorted(c["page"] for c in cits) == ["p. 1", "p. 2"]
    fam = next(f for f in client.get(f"/api/trees/{tree}/families", headers=admin).json() if f["id"] == fam_id)
    assert [(c["individual_id"], c["birth_order"]) for c in fam["children"]] == [(keep, 2)]
    assert client.get(f"/api/trees/{tree}/individuals/{dup}", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/individuals/{keep}", headers=admin).json()["notes"] == "from dup"
