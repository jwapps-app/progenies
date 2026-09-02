"""Security regression tests.

Authorization boundaries (cross-tree IDOR, viewer/admin roles, soft-deleted
trees), the auth token lifecycle (throttle, refresh rotation with reuse
detection, self-service password change, token-type confusion), family-graph
integrity (self-parent, self-marriage, duplicate children, ancestry cycles),
GEDCOM structure injection, input size caps, and the startup key guard.
"""
import io
import re
import time
import uuid

import pytest

import auth.router as auth_router
from config import settings

PASSWORD = "password123"

SMALL_GED = """0 HEAD
1 GEDC
2 VERS 5.5
1 CHAR UTF-8
0 @I1@ INDI
1 NAME {name} /Test/
0 TRLR
"""


@pytest.fixture(autouse=True)
def _reset_login_throttle():
    """The throttle is module state shared by every test in the session: a
    test that deliberately trips it must not leave the next one locked out."""
    auth_router._FAILED_LOGINS.clear()
    yield
    auth_router._FAILED_LOGINS.clear()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _login(client, username: str, password: str = PASSWORD):
    return client.post("/auth/login", json={"username": username, "password": password})


def _login_headers(client, username: str, password: str = PASSWORD) -> dict[str, str]:
    r = _login(client, username, password)
    assert r.status_code == 200, r.text
    return _bearer(r.json()["access_token"])


def _mk_user(client, admin, username: str) -> tuple[str, dict[str, str]]:
    r = client.post("/api/users", headers=admin, json={"username": username, "password": PASSWORD})
    assert r.status_code == 201, r.text
    return r.json()["id"], _login_headers(client, username)


def _mk_tree(client, headers, name: str) -> str:
    r = client.post("/api/trees", headers=headers, json={"name": name})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _mk_person(client, headers, tree: str, **fields) -> str:
    r = client.post(f"/api/trees/{tree}/individuals", headers=headers, json=fields)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _mk_family(client, headers, tree: str, **fields):
    return client.post(f"/api/trees/{tree}/families", headers=headers, json=fields)


def _upload(client, headers, tree: str, text: str, name: str = "sample.ged"):
    return client.post(
        f"/api/trees/{tree}/import",
        headers=headers,
        files={"file": (name, io.BytesIO(text.encode("utf-8")), "text/plain")},
    )


# http.cookiejar files a cookie the server set for the dotless host
# "testserver" under "testserver.local" — a cookie set by hand under plain
# "testserver" is a DIFFERENT jar entry that is never sent (and the two then
# collide on read). Replays must go under the .local domain, and the jar is
# cleared first so exactly one refresh cookie exists at any time.
_COOKIE_DOMAIN = "testserver.local"


def _refresh_cookie(client) -> str | None:
    values = [c.value for c in client.cookies.jar if c.name == "refresh_token"]
    assert len(values) <= 1, "more than one refresh cookie in the jar"
    return values[0] if values else None


def _set_refresh_cookie(client, value: str) -> None:
    client.cookies.delete("refresh_token")
    client.cookies.set("refresh_token", value, domain=_COOKIE_DOMAIN, path="/auth")


def _archive_count(tree: str) -> int:
    from database import SessionLocal
    from models import GedcomFile
    from sqlalchemy import func, select

    with SessionLocal() as db:
        return db.scalar(
            select(func.count(GedcomFile.id)).where(GedcomFile.tree_id == uuid.UUID(tree))
        )


# ---------------------------------------------------------------------------
# Authorization boundaries
# ---------------------------------------------------------------------------
def test_cross_tree_references_are_404(client, admin):
    """Another user's records must be unreachable — both through their own
    tree's URL (no access) and through MY tree's URL (wrong tree)."""
    _, other = _mk_user(client, admin, "sec_other")
    mine = _mk_tree(client, admin, "IdorMine")
    theirs = _mk_tree(client, other, "IdorTheirs")
    my_person = _mk_person(client, admin, mine, given_name="Mine")
    their_person = _mk_person(client, other, theirs, given_name="Theirs")
    r = _mk_family(client, other, theirs, husband_id=their_person)
    assert r.status_code == 201, r.text
    their_family = r.json()["id"]
    r = client.post(f"/api/trees/{theirs}/sources", headers=other, json={"title": "Register"})
    assert r.status_code == 201, r.text
    their_source = r.json()["id"]
    r = client.post(
        f"/api/trees/{theirs}/individuals/{their_person}/citations",
        headers=other,
        json={"source_id": their_source, "page": "p. 1"},
    )
    assert r.status_code == 201, r.text
    their_citation = r.json()["id"]

    # Tree-level: I have no access to their tree at all.
    assert client.get(f"/api/trees/{theirs}", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{theirs}/individuals", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{theirs}/descendants/{their_person}", headers=admin).status_code == 404
    r = client.post(
        f"/api/trees/{theirs}/duplicates/dismiss",
        headers=admin,
        json={"id_a": their_person, "id_b": my_person},
    )
    assert r.status_code == 404
    r = client.post(f"/api/trees/{theirs}/warnings/dismiss", headers=admin, json={"key": "k"})
    assert r.status_code == 404

    # Resource-level: their records reached through MY tree's URL.
    base = f"/api/trees/{mine}"
    assert client.get(f"{base}/individuals/{their_person}", headers=admin).status_code == 404
    assert client.put(f"{base}/individuals/{their_person}", headers=admin, json={"given_name": "X"}).status_code == 404
    assert client.delete(f"{base}/individuals/{their_person}", headers=admin).status_code == 404
    assert client.get(f"{base}/families/{their_family}", headers=admin).status_code == 404
    assert client.put(f"{base}/families/{their_family}", headers=admin, json={"notes": "X"}).status_code == 404
    assert client.delete(f"{base}/families/{their_family}", headers=admin).status_code == 404
    assert client.put(f"{base}/sources/{their_source}", headers=admin, json={"title": "X"}).status_code == 404
    assert client.delete(f"{base}/sources/{their_source}", headers=admin).status_code == 404
    assert client.get(f"{base}/individuals/{their_person}/citations", headers=admin).status_code == 404
    assert client.delete(f"{base}/citations/{their_citation}", headers=admin).status_code == 404
    r = client.post(
        f"{base}/individuals/{my_person}/merge", headers=admin, json={"duplicate_id": their_person}
    )
    assert r.status_code == 404
    # A citation pointing MY person at THEIR source must not be creatable.
    r = client.post(
        f"{base}/individuals/{my_person}/citations", headers=admin, json={"source_id": their_source}
    )
    assert r.status_code == 404
    # A family in my tree cannot pull in their person as a spouse or child.
    assert _mk_family(client, admin, mine, husband_id=their_person).status_code == 422
    r = _mk_family(client, admin, mine, husband_id=my_person, children=[{"individual_id": their_person}])
    assert r.status_code == 422
    assert client.get(f"{base}/descendants/{their_person}", headers=admin).status_code == 404
    assert client.get(f"{base}/ancestors/{their_person}", headers=admin).status_code == 404

    # Nothing of theirs was touched.
    r = client.get(f"/api/trees/{theirs}/individuals/{their_person}", headers=other)
    assert r.status_code == 200 and r.json()["given_name"] == "Theirs"
    assert client.get(f"/api/trees/{theirs}/families/{their_family}", headers=other).status_code == 200


def test_viewer_cannot_mutate(client, admin):
    tree = _mk_tree(client, admin, "ViewerRO")
    a = _mk_person(client, admin, tree, given_name="A")
    b = _mk_person(client, admin, tree, given_name="B")
    src = client.post(f"/api/trees/{tree}/sources", headers=admin, json={"title": "S"}).json()["id"]
    vid, viewer = _mk_user(client, admin, "sec_viewer")
    r = client.put(f"/api/trees/{tree}/shares", headers=admin, json={"user_id": vid, "role": "viewer"})
    assert r.status_code == 200, r.text

    assert client.get(f"/api/trees/{tree}/individuals", headers=viewer).status_code == 200
    assert _mk_family(client, viewer, tree, husband_id=a).status_code == 403
    assert client.post(f"/api/trees/{tree}/sources", headers=viewer, json={"title": "X"}).status_code == 403
    r = client.post(
        f"/api/trees/{tree}/individuals/{a}/citations", headers=viewer, json={"source_id": src}
    )
    assert r.status_code == 403
    r = client.post(f"/api/trees/{tree}/individuals/{a}/merge", headers=viewer, json={"duplicate_id": b})
    assert r.status_code == 403
    assert _upload(client, viewer, tree, SMALL_GED.format(name="Nope")).status_code == 403
    r = client.post(f"/api/trees/{tree}/duplicates/dismiss", headers=viewer, json={"id_a": a, "id_b": b})
    assert r.status_code == 403
    r = client.post(f"/api/trees/{tree}/warnings/dismiss", headers=viewer, json={"key": "k"})
    assert r.status_code == 403
    # Owner-only management is hidden entirely from a collaborator.
    assert client.put(f"/api/trees/{tree}", headers=viewer, json={"name": "Mine now"}).status_code == 404
    assert client.post(f"/api/trees/{tree}/share-link", headers=viewer).status_code == 404


def test_non_admin_cannot_manage_users(client, admin):
    uid, user = _mk_user(client, admin, "sec_plain")
    assert client.get("/api/users", headers=user).status_code == 403
    r = client.post("/api/users", headers=user, json={"username": "sec_smuggled", "password": PASSWORD})
    assert r.status_code == 403
    r = client.post(f"/api/users/{uid}/password", headers=user, json={"password": "newpassword1"})
    assert r.status_code == 403
    assert client.delete(f"/api/users/{uid}", headers=user).status_code == 403
    # Unauthenticated gets 401, not a hint about the role required.
    assert client.get("/api/users").status_code == 401


def test_admin_cannot_delete_self(client, admin):
    me = client.get("/auth/me", headers=admin).json()["id"]
    assert client.delete(f"/api/users/{me}", headers=admin).status_code == 400
    assert client.get("/auth/me", headers=admin).status_code == 200


def test_soft_deleted_tree_is_gone_everywhere(client, admin):
    tree = _mk_tree(client, admin, "SoftDeleted")
    pid = _mk_person(client, admin, tree, given_name="Ghost")
    assert _upload(client, admin, tree, SMALL_GED.format(name="Archived")).status_code == 200
    assert _archive_count(tree) == 1
    token = client.post(f"/api/trees/{tree}/share-link", headers=admin).json()["share_token"]
    share = {"X-Share-Token": token}
    assert client.get("/public/tree", headers=share).status_code == 200

    assert client.delete(f"/api/trees/{tree}", headers=admin).status_code == 204

    assert client.get(f"/api/trees/{tree}", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/individuals", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/individuals/{pid}", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/families", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/export", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/descendants/{pid}", headers=admin).status_code == 404
    assert client.get(f"/api/trees/{tree}/ancestors/{pid}", headers=admin).status_code == 404
    assert client.get("/public/tree", headers=share).status_code == 404
    assert client.get("/public/individuals", headers=share).status_code == 404
    assert client.get(f"/public/descendants/{pid}", headers=share).status_code == 404
    assert tree not in {t["id"] for t in client.get("/api/trees", headers=admin).json()}
    # The archived GEDCOM copies (recovery artifacts) went with it.
    assert _archive_count(tree) == 0


# ---------------------------------------------------------------------------
# Login throttle
# ---------------------------------------------------------------------------
def test_login_throttle_is_keyed_per_username_ip_pair(client, admin):
    _mk_user(client, admin, "sec_victim")
    _mk_user(client, admin, "sec_bystander")
    for _ in range(10):
        assert _login(client, "sec_victim", "wrong-password").status_code == 401
    # 11th attempt — even with the RIGHT password — is throttled.
    assert _login(client, "sec_victim").status_code == 429
    # The key is the lower-cased username hash, so a case variant shares it.
    assert _login(client, "SEC_VICTIM").status_code == 429
    # A different account from the same client is unaffected (per-IP cap is
    # 20, and the per-username cap belongs to the victim alone).
    assert _login(client, "sec_bystander").status_code == 200
    # Ten more failures spread over made-up usernames push the per-IP count
    # to 20 — now the whole client is throttled, bystander included.
    for i in range(10):
        assert _login(client, f"sec_nobody{i}", "x").status_code == 401
    assert _login(client, "sec_bystander").status_code == 429


def test_login_throttle_caps_are_separate_per_key_kind():
    """Unit-level: each key kind has its own cap, so a botnet spread over
    many IPs can't reach the per-pair cap and a per-user lockout takes far
    more than one attacker's worth of failures."""
    now = time.monotonic()
    auth_router._FAILED_LOGINS["pair:abc:1.2.3.4"] = [now] * 10
    auth_router._FAILED_LOGINS["ip:1.2.3.4"] = [now] * 19
    auth_router._FAILED_LOGINS["user:abc"] = [now] * 99
    assert auth_router._throttled("pair:abc:1.2.3.4") is True
    assert auth_router._throttled("ip:1.2.3.4") is False
    assert auth_router._throttled("user:abc") is False
    auth_router._FAILED_LOGINS["user:abc"].append(now)
    assert auth_router._throttled("user:abc") is True
    # Stale entries are dropped by the time-based sweep, and checking a key
    # never inserts it.
    auth_router._FAILED_LOGINS["ip:old"] = [now - auth_router._THROTTLE_WINDOW - 1]
    auth_router._sweep_failed_logins(now)
    assert "ip:old" not in auth_router._FAILED_LOGINS
    assert auth_router._throttled("ip:never-seen") is False
    assert "ip:never-seen" not in auth_router._FAILED_LOGINS


def test_login_rejects_oversized_credentials(client, admin):
    r = _login(client, "a" * 100_000, "x")
    assert r.status_code == 422
    r = _login(client, "admin", "x" * 1_000)
    assert r.status_code == 422
    assert _login(client, "", PASSWORD).status_code == 422
    # None of those counted as a failure against anyone.
    assert auth_router._FAILED_LOGINS == {}


# ---------------------------------------------------------------------------
# Token lifecycle
# ---------------------------------------------------------------------------
def test_refresh_rotation_detects_reuse(client, admin):
    _mk_user(client, admin, "sec_rotate")
    assert _login(client, "sec_rotate").status_code == 200
    first = _refresh_cookie(client)
    assert first

    r = client.post("/auth/refresh")
    assert r.status_code == 200, r.text
    second = _refresh_cookie(client)
    assert second and second != first

    r = client.post("/auth/refresh")
    assert r.status_code == 200, r.text
    third = _refresh_cookie(client)
    assert third and third not in (first, second)
    live_access = r.json()["access_token"]
    assert client.get("/auth/me", headers=_bearer(live_access)).status_code == 200

    # Replaying the FIRST cookie (already rotated away) is reuse: it must fail,
    # AND take the current session down with it.
    _set_refresh_cookie(client, first)
    assert client.post("/auth/refresh").status_code == 401
    _set_refresh_cookie(client, third)
    assert client.post("/auth/refresh").status_code == 401
    assert client.get("/auth/me", headers=_bearer(live_access)).status_code == 401
    # A fresh login works and yields a new, usable refresh cookie.
    assert _login(client, "sec_rotate").status_code == 200
    assert client.post("/auth/refresh").status_code == 200


def test_logout_retires_the_refresh_session(client, admin):
    _mk_user(client, admin, "sec_logout")
    assert _login(client, "sec_logout").status_code == 200
    cookie = _refresh_cookie(client)
    assert client.post("/auth/logout").status_code == 204
    _set_refresh_cookie(client, cookie)
    assert client.post("/auth/refresh").status_code == 401


def test_multiple_devices_keep_independent_sessions(client, admin):
    """Logging in on a second device must not sign the first one out."""
    _mk_user(client, admin, "sec_devices")
    assert _login(client, "sec_devices").status_code == 200
    desktop = _refresh_cookie(client)
    assert _login(client, "sec_devices").status_code == 200
    ipad = _refresh_cookie(client)
    assert desktop != ipad
    _set_refresh_cookie(client, desktop)
    assert client.post("/auth/refresh").status_code == 200
    _set_refresh_cookie(client, ipad)
    assert client.post("/auth/refresh").status_code == 200


def test_self_service_password_change(client, admin):
    _mk_user(client, admin, "sec_pw")
    r = _login(client, "sec_pw")
    old_access = r.json()["access_token"]
    old_refresh = _refresh_cookie(client)
    headers = _bearer(old_access)

    r = client.post(
        "/auth/password",
        headers=headers,
        json={"current_password": "not-the-password", "new_password": "newpassword1"},
    )
    assert r.status_code == 400, r.text
    # Unchanged: old credentials still work after a failed attempt.
    assert client.get("/auth/me", headers=headers).status_code == 200
    # The new password must still meet the policy.
    r = client.post(
        "/auth/password", headers=headers, json={"current_password": PASSWORD, "new_password": "short"}
    )
    assert r.status_code == 422
    assert client.post("/auth/password", json={"current_password": PASSWORD, "new_password": "newpassword1"}).status_code == 401

    r = client.post(
        "/auth/password",
        headers=headers,
        json={"current_password": PASSWORD, "new_password": "newpassword1"},
    )
    assert r.status_code == 200, r.text
    fresh = r.json()["access_token"]
    # The caller stays signed in on the fresh pair; everything older is dead.
    assert client.get("/auth/me", headers=_bearer(fresh)).status_code == 200
    assert client.post("/auth/refresh").status_code == 200
    assert client.get("/auth/me", headers=headers).status_code == 401
    _set_refresh_cookie(client, old_refresh)
    assert client.post("/auth/refresh").status_code == 401
    assert _login(client, "sec_pw", PASSWORD).status_code == 401
    assert _login(client, "sec_pw", "newpassword1").status_code == 200


def test_token_types_are_not_interchangeable(client, admin):
    _mk_user(client, admin, "sec_confuse")
    r = _login(client, "sec_confuse")
    access = r.json()["access_token"]
    refresh_cookie = _refresh_cookie(client)
    # A refresh JWT presented as a Bearer token is not an access token.
    assert client.get("/auth/me", headers=_bearer(refresh_cookie)).status_code == 401
    # An access JWT presented as the refresh cookie is not a refresh token.
    _set_refresh_cookie(client, access)
    assert client.post("/auth/refresh").status_code == 401
    # Garbage and a signature-stripped token are rejected too.
    assert client.get("/auth/me", headers=_bearer("not.a.jwt")).status_code == 401
    unsigned = access.rsplit(".", 1)[0] + "."
    assert client.get("/auth/me", headers=_bearer(unsigned)).status_code == 401


def test_bootstrap_token_gates_first_registration(client, admin, monkeypatch):
    """With BOOTSTRAP_TOKEN set, /auth/register refuses a missing or wrong
    token BEFORE it even looks at whether registration is open."""
    monkeypatch.setattr(settings, "BOOTSTRAP_TOKEN", "s3cret-bootstrap")
    r = client.post("/auth/register", json={"username": "sec_boot", "password": PASSWORD})
    assert r.status_code == 403 and "bootstrap" in r.json()["detail"].lower()
    r = client.post(
        "/auth/register",
        json={"username": "sec_boot", "password": PASSWORD, "bootstrap_token": "wrong"},
    )
    assert r.status_code == 403 and "bootstrap" in r.json()["detail"].lower()
    # Right token: past the gate, and then the normal "closed" rule applies
    # because the admin account already exists.
    r = client.post(
        "/auth/register",
        json={"username": "sec_boot", "password": PASSWORD, "bootstrap_token": "s3cret-bootstrap"},
    )
    assert r.status_code == 403 and "closed" in r.json()["detail"].lower()


def test_secret_key_guard():
    from main import _check_secret_key

    with pytest.raises(RuntimeError):
        _check_secret_key("short")
    with pytest.raises(RuntimeError):
        _check_secret_key("  change-me-in-production \n")
    with pytest.raises(RuntimeError):
        _check_secret_key("x" * 31 + " ")  # trailing space doesn't count
    _check_secret_key("x" * 32)


# ---------------------------------------------------------------------------
# Family graph integrity
# ---------------------------------------------------------------------------
def test_family_update_rejects_parent_who_is_a_child(client, admin):
    tree = _mk_tree(client, admin, "SelfParentUpdate")
    dad = _mk_person(client, admin, tree, given_name="Dad")
    mom = _mk_person(client, admin, tree, given_name="Mom")
    kid = _mk_person(client, admin, tree, given_name="Kid")
    r = _mk_family(client, admin, tree, husband_id=dad, wife_id=mom, children=[{"individual_id": kid}])
    assert r.status_code == 201, r.text
    fam = r.json()["id"]
    url = f"/api/trees/{tree}/families/{fam}"
    # Re-parenting to an existing child WITHOUT touching the children list.
    assert client.put(url, headers=admin, json={"husband_id": kid}).status_code == 422
    assert client.put(url, headers=admin, json={"wife_id": kid}).status_code == 422
    # Adding a parent to the children list.
    assert client.put(url, headers=admin, json={"children": [{"individual_id": dad}]}).status_code == 422
    # Both at once.
    r = client.put(url, headers=admin, json={"husband_id": mom, "children": [{"individual_id": mom}]})
    assert r.status_code == 422
    # The family is untouched.
    body = client.get(url, headers=admin).json()
    assert body["husband_id"] == dad and body["wife_id"] == mom
    assert [c["individual_id"] for c in body["children"]] == [kid]


def test_family_rejects_same_person_as_both_spouses(client, admin):
    tree = _mk_tree(client, admin, "SelfMarriage")
    p = _mk_person(client, admin, tree, given_name="Solo")
    q = _mk_person(client, admin, tree, given_name="Other")
    assert _mk_family(client, admin, tree, husband_id=p, wife_id=p).status_code == 422
    r = _mk_family(client, admin, tree, husband_id=p, wife_id=q)
    assert r.status_code == 201, r.text
    fam = r.json()["id"]
    r = client.put(f"/api/trees/{tree}/families/{fam}", headers=admin, json={"wife_id": p})
    assert r.status_code == 422
    assert client.get(f"/api/trees/{tree}/families/{fam}", headers=admin).json()["wife_id"] == q


def test_family_rejects_duplicate_child_ids(client, admin):
    tree = _mk_tree(client, admin, "DupChild")
    dad = _mk_person(client, admin, tree, given_name="Dad")
    kid = _mk_person(client, admin, tree, given_name="Kid")
    twice = [{"individual_id": kid, "birth_order": 1}, {"individual_id": kid, "birth_order": 2}]
    assert _mk_family(client, admin, tree, husband_id=dad, children=twice).status_code == 422
    r = _mk_family(client, admin, tree, husband_id=dad)
    assert r.status_code == 201, r.text
    r = client.put(f"/api/trees/{tree}/families/{r.json()['id']}", headers=admin, json={"children": twice})
    assert r.status_code == 422


def test_family_rejects_ancestry_cycle(client, admin):
    tree = _mk_tree(client, admin, "Cycle")
    a = _mk_person(client, admin, tree, given_name="A")
    b = _mk_person(client, admin, tree, given_name="B")
    c = _mk_person(client, admin, tree, given_name="C")
    # A is B's parent; B is C's parent.
    assert _mk_family(client, admin, tree, husband_id=a, children=[{"individual_id": b}]).status_code == 201
    r = _mk_family(client, admin, tree, wife_id=b, children=[{"individual_id": c}])
    assert r.status_code == 201, r.text
    # Direct loop: B as A's parent.
    assert _mk_family(client, admin, tree, husband_id=b, children=[{"individual_id": a}]).status_code == 422
    # Longer loop: C as A's parent (C -> B -> A -> C).
    assert _mk_family(client, admin, tree, wife_id=c, children=[{"individual_id": a}]).status_code == 422
    # Via update: an otherwise-fine family gains A as a child of its own descendant.
    r = _mk_family(client, admin, tree, husband_id=c)
    assert r.status_code == 201, r.text
    fam = r.json()["id"]
    r = client.put(f"/api/trees/{tree}/families/{fam}", headers=admin, json={"children": [{"individual_id": a}]})
    assert r.status_code == 422
    # And by swapping a parent in under existing children: (C, children=[D]) then husband -> D's descendant.
    d = _mk_person(client, admin, tree, given_name="D")
    r = client.put(f"/api/trees/{tree}/families/{fam}", headers=admin, json={"children": [{"individual_id": d}]})
    assert r.status_code == 200, r.text
    assert _mk_family(client, admin, tree, husband_id=d, children=[{"individual_id": a}]).status_code == 422
    # Legitimate unrelated additions still work.
    e = _mk_person(client, admin, tree, given_name="E")
    assert _mk_family(client, admin, tree, husband_id=e, children=[{"individual_id": a}]).status_code == 201
    # Ancestor chart of C still resolves cleanly (A, B above it).
    anc = client.get(f"/api/trees/{tree}/ancestors/{c}", headers=admin)
    assert anc.status_code == 200 and anc.json()["children"][0]["id"] == b


def test_input_size_caps(client, admin):
    tree = _mk_tree(client, admin, "Caps")
    base = f"/api/trees/{tree}"
    assert client.post(f"{base}/individuals", headers=admin, json={"given_name": "x" * 201}).status_code == 422
    assert client.post(f"{base}/individuals", headers=admin, json={"given_name": "x" * 200}).status_code == 201
    assert client.post(f"{base}/individuals", headers=admin, json={"notes": "x" * 65_537}).status_code == 422
    assert client.post(f"{base}/individuals", headers=admin, json={"birth_date": "x" * 65}).status_code == 422
    assert client.post(f"{base}/individuals", headers=admin, json={"age": "x" * 33}).status_code == 422
    assert client.post(f"{base}/sources", headers=admin, json={"title": "x" * 513}).status_code == 422
    assert client.post("/api/trees", headers=admin, json={"name": "T", "description": "x" * 4_097}).status_code == 422
    kid = _mk_person(client, admin, tree, given_name="Kid")
    r = _mk_family(client, admin, tree, children=[{"individual_id": kid, "birth_order": -1}])
    assert r.status_code == 422
    r = _mk_family(client, admin, tree, children=[{"individual_id": kid, "birth_order": 2**31}])
    assert r.status_code == 422
    assert _mk_family(client, admin, tree, marriage_order=2**31).status_code == 422


# ---------------------------------------------------------------------------
# GEDCOM structure injection
# ---------------------------------------------------------------------------
def test_note_line_breaks_cannot_inject_gedcom_records(client, admin):
    """A note carrying line breaks the parser recognises but "\\n" (CR, FF,
    NEL, LS...) used to be written as one physical line — which the reader
    then split into brand-new records. It must round-trip as ONE person with
    the text intact."""
    tree = _mk_tree(client, admin, "Inject")
    notes = "Line one\r0 @I999@ INDI\r\n1 NAME Evil /Person/\x0c0 @F999@ FAM\x850 TRLR tail"
    _mk_person(client, admin, tree, given_name="Honest", notes=notes)
    r = client.get(f"/api/trees/{tree}/export", headers=admin)
    assert r.status_code == 200, r.text
    text = r.text
    level0 = [line for line in text.splitlines() if line.startswith("0 ")]
    assert sum(1 for line in level0 if line.endswith(" INDI")) == 1
    assert not any(line.endswith(" FAM") for line in level0)
    assert level0[-1] == "0 TRLR" and level0.count("0 TRLR") == 1
    assert "2 CONT 0 @I999@ INDI" in text

    tree2 = _mk_tree(client, admin, "Inject2")
    r = _upload(client, admin, tree2, text)
    assert r.status_code == 200, r.text
    assert r.json()["individuals_imported"] == 1 and r.json()["families_imported"] == 0
    people = client.get(f"/api/trees/{tree2}/individuals?include_details=true", headers=admin).json()
    assert len(people) == 1
    got = people[0]["notes"]
    for fragment in ("Line one", "0 @I999@ INDI", "1 NAME Evil /Person/", "0 @F999@ FAM", "0 TRLR", "tail"):
        assert fragment in got, fragment
    assert got.startswith("Line one\n0 @I999@ INDI\n1 NAME Evil /Person/\n")


def test_gedcom_xref_must_be_a_plain_pointer(client, admin):
    tree = _mk_tree(client, admin, "XrefInject")
    bad = "@I1@ INDI\n1 NAME X"
    assert client.post(f"/api/trees/{tree}/individuals", headers=admin, json={"gedcom_xref": bad}).status_code == 422
    assert _mk_family(client, admin, tree, gedcom_xref=bad).status_code == 422
    assert client.post(f"/api/trees/{tree}/sources", headers=admin, json={"gedcom_xref": bad}).status_code == 422
    for bad in ("I1", "@@", "@I 1@", "@" + "I" * 25 + "@"):
        r = client.post(f"/api/trees/{tree}/individuals", headers=admin, json={"gedcom_xref": bad})
        assert r.status_code == 422, bad
    pid = _mk_person(client, admin, tree, given_name="Ok", gedcom_xref="@I1@")
    r = client.put(f"/api/trees/{tree}/individuals/{pid}", headers=admin, json={"gedcom_xref": bad})
    assert r.status_code == 422
    # Empty clears it.
    r = client.put(f"/api/trees/{tree}/individuals/{pid}", headers=admin, json={"gedcom_xref": ""})
    assert r.status_code == 200 and r.json()["gedcom_xref"] is None


def test_export_ignores_malformed_stored_xrefs():
    """Defence in depth below the API: a stored xref that isn't a plain id
    (however it got there) is replaced on export, never emitted verbatim."""
    from services.gedcom_export import _assign_xrefs

    class _Rec:
        def __init__(self, rid, xref):
            self.id, self.gedcom_xref = rid, xref

    mapping = _assign_xrefs([_Rec(1, "@I1@ INDI\n1 NAME X"), _Rec(2, "@I7@"), _Rec(3, "@I7@")], "I")
    assert mapping[2] == "@I7@"
    assert re.fullmatch(r"@I\d+@", mapping[1]) and mapping[1] != "@I7@"
    assert re.fullmatch(r"@I\d+@", mapping[3]) and mapping[3] not in (mapping[1], "@I7@")


def test_export_filename_survives_non_latin_tree_names(client, admin):
    tree = _mk_tree(client, admin, "Οικογένεια 家族 ✓")
    _mk_person(client, admin, tree, given_name="Someone")
    r = client.get(f"/api/trees/{tree}/export", headers=admin)
    assert r.status_code == 200, r.text
    disposition = r.headers["content-disposition"]
    assert 'filename="tree.ged"' in disposition
    assert "filename*=UTF-8''%CE%9F" in disposition
    assert disposition.isascii()


def test_gedcom_archive_keeps_only_newest_five(client, admin):
    tree = _mk_tree(client, admin, "Retention")
    for i in range(7):
        assert _upload(client, admin, tree, SMALL_GED.format(name=f"Person{i}"), name=f"f{i}.ged").status_code == 200
    assert _archive_count(tree) == 5
    # Exports: each distinct export archives once; still capped.
    for i in range(7):
        _mk_person(client, admin, tree, given_name=f"Extra{i}")
        assert client.get(f"/api/trees/{tree}/export", headers=admin).status_code == 200
    assert _archive_count(tree) == 10  # 5 imports + 5 exports
