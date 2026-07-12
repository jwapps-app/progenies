"""End-to-end smoke tests: auth, tree/person/family CRUD, sharing, GEDCOM.

These are the CI gate — image publishing depends on them. They exercise the
API the way the frontend does, against a real (disposable) Postgres.
"""
import io

SAMPLE_GED = """0 HEAD
1 SOUR Test
1 GEDC
2 VERS 5.5
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @N1@ NOTE Emigrated 1885
0 @S1@ SOUR
1 TITL Parish register
0 @I1@ INDI
1 NAME Robert /Anderson/
2 NICK Bob
1 SEX M
1 BIRT
2 DATE 12 MAR 1880
1 SOUR @S1@
2 PAGE p. 43
1 NOTE Line one
2 CONT Line two
0 @I2@ INDI
1 NAME Mary /Jones/
1 NAME Mary /Anderson/
2 TYPE married
1 SEX F
1 NOTE @N1@
0 @I3@ INDI
1 NAME Junior /Anderson/
1 SEX M
1 FAMC @F1@
2 PEDI adopted
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1900
1 _ORDER 2
1 _UNMAR Y
0 TRLR
"""


def _upload(client, headers, tree_id, text, name="sample.ged", force=False):
    return client.post(
        f"/api/trees/{tree_id}/import" + ("?force=true" if force else ""),
        headers=headers,
        files={"file": (name, io.BytesIO(text.encode("utf-8")), "text/plain")},
    )


def _mk_tree(client, headers, name):
    r = client.post("/api/trees", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def test_registration_bootstrap_and_closes(client, admin):
    # `admin` fixture registered the first account; registration must now be closed.
    r = client.get("/auth/registration")
    assert r.status_code == 200 and r.json()["open"] is False
    r = client.post("/auth/register", json={"username": "intruder", "password": "password123"})
    assert r.status_code == 403


def test_me(client, admin):
    r = client.get("/auth/me", headers=admin)
    assert r.status_code == 200
    body = r.json()
    assert body["username"] == "admin" and body["is_admin"] is True


def test_individual_crud_roundtrips_all_fields(client, admin):
    tree = _mk_tree(client, admin, "CRUD")
    r = client.post(
        f"/api/trees/{tree}/individuals",
        headers=admin,
        json={
            "given_name": "Robert",
            "middle_name": "James",
            "surname": "Anderson",
            "married_name": "Smythe",
            "nickname": "Bob",
            "sex": "M",
            "birth_date": "12 MAR 1880",
            "gedcom_xref": "@I9@",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    for field, want in [
        ("nickname", "Bob"),
        ("married_name", "Smythe"),
        ("gedcom_xref", "@I9@"),
        ("birth_date", "12 MAR 1880"),
    ]:
        assert body[field] == want, field
    # Update one field; the others must survive.
    r = client.put(
        f"/api/trees/{tree}/individuals/{body['id']}", headers=admin, json={"notes": "hello"}
    )
    assert r.status_code == 200 and r.json()["nickname"] == "Bob"


def test_family_child_relation(client, admin):
    tree = _mk_tree(client, admin, "Family")
    ids = {}
    for name in ("Dad", "Mom", "Kid"):
        r = client.post(f"/api/trees/{tree}/individuals", headers=admin, json={"given_name": name})
        ids[name] = r.json()["id"]
    r = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={
            "husband_id": ids["Dad"],
            "wife_id": ids["Mom"],
            "children": [{"individual_id": ids["Kid"], "birth_order": 1, "relation": "adopted"}],
        },
    )
    assert r.status_code == 201, r.text
    fam = r.json()
    assert fam["children"][0]["relation"] == "adopted"
    # Change the relation via family update.
    fam["children"][0]["relation"] = "step"
    r = client.put(
        f"/api/trees/{tree}/families/{fam['id']}",
        headers=admin,
        json={"husband_id": ids["Dad"], "wife_id": ids["Mom"], "children": fam["children"]},
    )
    assert r.status_code == 200 and r.json()["children"][0]["relation"] == "step"


def test_gedcom_import_export_roundtrip(client, admin):
    tree = _mk_tree(client, admin, "Gedcom")
    r = _upload(client, admin, tree, SAMPLE_GED)
    assert r.status_code == 200, r.text
    summary = r.json()
    assert summary["individuals_imported"] == 3
    assert summary["families_imported"] == 1
    assert summary["children_links"] == 1

    # Nickname, married name, PEDI relation, shared-note pointer, and the
    # custom _ORDER/_UNMAR tags must all have been parsed.
    people = client.get(f"/api/trees/{tree}/individuals", headers=admin).json()
    robert = next(p for p in people if p["given_name"] == "Robert")
    mary = next(p for p in people if p["given_name"] == "Mary")
    assert robert["nickname"] == "Bob"
    assert mary["married_name"] == "Anderson" and mary["surname"] == "Jones"
    assert "Line one\nLine two" in (robert["notes"] or "")
    assert mary["notes"] == "Emigrated 1885"  # NOTE @N1@ dereferenced

    fams = client.get(f"/api/trees/{tree}/families", headers=admin).json()
    assert fams[0]["children"][0]["relation"] == "adopted"  # PEDI
    assert fams[0]["marriage_order"] == 2  # _ORDER
    assert fams[0]["unmarried"] is True  # _UNMAR

    # Export must round-trip all of it.
    r = client.get(f"/api/trees/{tree}/export", headers=admin)
    assert r.status_code == 200
    text = r.text
    for marker in (
        "2 NICK Bob",
        "2 TYPE married",
        "0 @I1@ INDI",
        "1 CHIL @I3@",
        "2 PEDI adopted",
        "1 _ORDER 2",
        "1 _UNMAR Y",
        "1 SOUR @S1@",
        "2 PAGE p. 43",
    ):
        assert marker in text, marker

    # Importing the export into a fresh tree preserves counts AND fidelity.
    tree2 = _mk_tree(client, admin, "Gedcom2")
    r = _upload(client, admin, tree2, text, name="reexport.ged")
    assert r.status_code == 200, r.text
    s2 = r.json()
    assert s2["individuals_imported"] == 3 and s2["families_imported"] == 1
    fams2 = client.get(f"/api/trees/{tree2}/families", headers=admin).json()
    assert fams2[0]["children"][0]["relation"] == "adopted"
    assert fams2[0]["marriage_order"] == 2 and fams2[0]["unmarried"] is True


def test_import_xref_collision_gets_fresh_ids(client, admin):
    """Two files that both use @I1@ must not corrupt the tree's export."""
    tree = _mk_tree(client, admin, "XrefCollide")
    assert _upload(client, admin, tree, SAMPLE_GED).status_code == 200
    other = SAMPLE_GED.replace("Robert", "Zed").replace("Mary", "Zoe").replace("Junior", "Zig")
    assert _upload(client, admin, tree, other, name="other.ged").status_code == 200
    text = client.get(f"/api/trees/{tree}/export", headers=admin).text
    # Every level-0 record id must be unique.
    ids = [line.split()[1] for line in text.splitlines() if line.startswith("0 @")]
    assert len(ids) == len(set(ids)), "duplicate xrefs in export"


def test_list_individuals_omits_photos_by_default(client, admin):
    tree = _mk_tree(client, admin, "Photos")
    r = client.post(
        f"/api/trees/{tree}/individuals",
        headers=admin,
        json={"given_name": "Pic", "photo_url": "data:image/jpeg;base64,QUJD"},
    )
    pid = r.json()["id"]
    listed = client.get(f"/api/trees/{tree}/individuals", headers=admin).json()
    assert listed[0]["photo_url"] is None
    listed = client.get(f"/api/trees/{tree}/individuals?include_photos=true", headers=admin).json()
    assert listed[0]["photo_url"]
    detail = client.get(f"/api/trees/{tree}/individuals/{pid}", headers=admin).json()
    assert detail["photo_url"]


def test_duplicate_import_guard(client, admin):
    tree = _mk_tree(client, admin, "DupGuard")
    assert _upload(client, admin, tree, SAMPLE_GED).status_code == 200
    # Exact same file again → rejected.
    r = _upload(client, admin, tree, SAMPLE_GED)
    assert r.status_code == 409
    # …unless forced.
    r = _upload(client, admin, tree, SAMPLE_GED, force=True)
    assert r.status_code == 200


def test_merge_fills_fields_and_keeps_children(client, admin):
    tree = _mk_tree(client, admin, "Merge")

    def mk(payload):
        return client.post(f"/api/trees/{tree}/individuals", headers=admin, json=payload).json()["id"]

    survivor = mk({"given_name": "John", "surname": "Smith"})
    dup = mk(
        {
            "given_name": "John",
            "surname": "Smith",
            "nickname": "Jack",
            "married_name": "Smythe",
            "photo_url": "data:image/jpeg;base64,QUJD",
        }
    )
    kid = mk({"given_name": "Kid"})
    # The two Johns are (wrongly) married to each other with a child.
    r = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={
            "husband_id": survivor,
            "wife_id": dup,
            "children": [{"individual_id": kid, "birth_order": 1}],
        },
    )
    assert r.status_code == 201
    r = client.post(
        f"/api/trees/{tree}/individuals/{survivor}/merge",
        headers=admin,
        json={"duplicate_id": dup},
    )
    assert r.status_code == 204, r.text
    merged = client.get(f"/api/trees/{tree}/individuals/{survivor}", headers=admin).json()
    assert merged["nickname"] == "Jack" and merged["married_name"] == "Smythe"
    assert merged["photo_url"]
    # The child link must survive as a single-parent family, not be cascaded away.
    fams = client.get(f"/api/trees/{tree}/families", headers=admin).json()
    assert any(len(f["children"]) == 1 for f in fams)


def test_public_share_link_omits_sensitive_fields(client, admin):
    """The unauthenticated /public/{token} surface must expose only what the
    read-only chart renders — never notes, places, gedcom_xref, or timestamps."""
    tree = _mk_tree(client, admin, "PublicLeak")
    r = client.post(
        f"/api/trees/{tree}/individuals",
        headers=admin,
        json={
            "given_name": "Secret",
            "surname": "Person",
            "notes": "PRIVATE NOTE",
            "birth_place": "Hidden Village",
            "death_place": "Hidden Town",
            "gedcom_xref": "@I42@",
            "photo_url": "data:image/jpeg;base64,QUJD",
        },
    )
    assert r.status_code == 201, r.text
    person_id = r.json()["id"]
    fam = client.post(
        f"/api/trees/{tree}/families",
        headers=admin,
        json={
            "husband_id": person_id,
            "married_place": "Secret Chapel",
            "notes": "FAMILY SECRET",
            "gedcom_xref": "@F7@",
        },
    )
    assert fam.status_code == 201, fam.text

    token = client.post(f"/api/trees/{tree}/share-link", headers=admin).json()["share_token"]
    assert token

    people = client.get(f"/public/{token}/individuals").json()
    assert people, "public individuals should be listed"
    for p in people:
        for leaked in ("notes", "birth_place", "death_place", "gedcom_xref", "photo_url", "tree_id", "created_at"):
            assert leaked not in p, f"public individual leaked {leaked}"
        assert p["given_name"] == "Secret"  # rendered fields still present

    fams = client.get(f"/public/{token}/families").json()
    assert fams, "public families should be listed"
    for f in fams:
        for leaked in ("notes", "married_place", "divorced_date", "married_date", "gedcom_xref", "tree_id"):
            assert leaked not in f, f"public family leaked {leaked}"

    # Revoking the link closes the door.
    client.delete(f"/api/trees/{tree}/share-link", headers=admin)
    assert client.get(f"/public/{token}/individuals").status_code == 404


def test_sharing_roles(client, admin):
    tree = _mk_tree(client, admin, "Shared")
    # Admin creates a second account and shares the tree read-only.
    r = client.post("/api/users", headers=admin, json={"username": "viewer", "password": "password123"})
    assert r.status_code == 201, r.text
    viewer_id = r.json()["id"]
    r = client.put(
        f"/api/trees/{tree}/shares", headers=admin, json={"user_id": viewer_id, "role": "viewer"}
    )
    assert r.status_code == 200, r.text

    tok = client.post(
        "/auth/login", json={"username": "viewer", "password": "password123"}
    ).json()["access_token"]
    viewer = {"Authorization": f"Bearer {tok}"}

    assert client.get(f"/api/trees/{tree}", headers=viewer).status_code == 200
    r = client.post(f"/api/trees/{tree}/individuals", headers=viewer, json={"given_name": "Nope"})
    assert r.status_code == 403
    # Upgrade to editor → write allowed.
    client.put(f"/api/trees/{tree}/shares", headers=admin, json={"user_id": viewer_id, "role": "editor"})
    r = client.post(f"/api/trees/{tree}/individuals", headers=viewer, json={"given_name": "Yep"})
    assert r.status_code == 201
    # Revoke → tree hidden entirely.
    client.delete(f"/api/trees/{tree}/shares/{viewer_id}", headers=admin)
    assert client.get(f"/api/trees/{tree}", headers=viewer).status_code == 404
