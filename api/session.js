// 두피 진단 회차 기록 저장/조회 — Supabase
// Vercel 환경변수 2개만 등록하면 켜집니다:
//   SUPABASE_URL          예) https://xxxxxxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role 키 (절대 클라이언트에 노출하지 않음)
// 키가 없으면 501을 돌려주고, 앱은 브라우저 저장만으로 정상 동작합니다.

const BUCKET = "scalp-photos";

export default async function handler(req, res) {
  const URL_ = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;

  const H = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
  };
  const rest = (path, init = {}) =>
    fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });

  /* ── 연결 점검 (브라우저에서 /api/session?diag=1 로 열어봅니다)
        키 값 자체는 절대 출력하지 않습니다. 확인이 끝나면 지워도 됩니다. ── */
  if (req.method === "GET" && req.query && req.query.diag === "1") {
    const out = {
      SUPABASE_URL_설정: !!URL_,
      SUPABASE_SERVICE_KEY_설정: !!KEY,
      주소: URL_ ? String(URL_).replace(/^https?:\/\//, "").replace(/\/+$/, "") : null,
      주소_끝에_슬래시: URL_ ? /\/$/.test(URL_) : null,
      키_길이: KEY ? KEY.length : 0,
      키_종류: null,
      함수가_보는_변수이름들: Object.keys(process.env)
        .filter((k) => /SUPA|SUPB|GEMINI|KEY|URL/i.test(k))
        .sort(),
      테이블: {},
      스토리지: null,
    };
    try {
      const payload = JSON.parse(Buffer.from(String(KEY).split(".")[1], "base64").toString());
      out.키_종류 = payload.role || "알 수 없음";
    } catch (e) { out.키_종류 = "JWT 형식이 아님"; }

    if (URL_ && KEY) {
      for (const t of ["scalp_customers", "scalp_sessions", "scalp_settings"]) {
        try {
          const r = await rest(`${t}?select=count&limit=1`);
          out.테이블[t] = r.ok ? "정상" : `오류 ${r.status}: ${(await r.text()).slice(0, 120)}`;
        } catch (e) { out.테이블[t] = "연결 실패: " + e.message; }
      }
      try {
        const r = await fetch(`${URL_}/storage/v1/bucket/${BUCKET}`, { headers: H });
        out.스토리지 = r.ok ? "정상" : `오류 ${r.status}`;
      } catch (e) { out.스토리지 = "연결 실패"; }
    }
    return res.status(200).json(out);
  }

  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!URL_ || !KEY) return res.status(501).json({ error: "Supabase 미설정" });

  try {
    const { action, customer, session, photos } = req.body || {};

    /* ── 고객 조회/생성 ─────────────────────────────── */
    const findOrCreate = async () => {
      const q = `scalp_customers?name=eq.${encodeURIComponent(customer.name)}&phone4=eq.${encodeURIComponent(customer.phone4)}&select=id`;
      const found = await (await rest(q)).json();
      if (Array.isArray(found) && found.length) {
        if (customer.designer) {
          await rest(`scalp_customers?id=eq.${found[0].id}`, {
            method: "PATCH",
            body: JSON.stringify({ designer: customer.designer }),
          });
        }
        return found[0].id;
      }
      const created = await (
        await rest("scalp_customers", {
          method: "POST",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            name: customer.name,
            phone4: customer.phone4,
            designer: customer.designer || null,
            consent_at: new Date().toISOString(),
          }),
        })
      ).json();
      return created?.[0]?.id;
    };

    /* ── 저장 ───────────────────────────────────────── */
    if (action === "save") {
      const customerId = await findOrCreate();
      if (!customerId) return res.status(500).json({ error: "고객 등록 실패" });

      // 사진 업로드 (비공개 버킷)
      const paths = {};
      for (const [region, b64] of Object.entries(photos || {})) {
        const path = `${customerId}/${session.round}_${region}_${Date.now()}.jpg`;
        const up = await fetch(`${URL_}/storage/v1/object/${BUCKET}/${path}`, {
          method: "POST",
          headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "image/jpeg" },
          body: Buffer.from(b64, "base64"),
        });
        if (up.ok) paths[region] = path;
      }

      const row = {
        customer_id: customerId,
        round: session.round,
        taken_at: session.date,
        designer: session.designer || null,
        score: session.score,
        grade: session.grade,
        grades: session.grades,
        scalp_type: session.type || null,
        detailed_type: session.detailedType || null,
        conditions: session.conditions || [],
        summary: session.summary || "",
        diagnosis: session.diagnosis || "",
        recommend_ingredients: session.recommendIngredients || [],
        avoid_ingredients: session.avoidIngredients || [],
        cares: session.cares || [],
        lifestyle: session.lifestyle || [],
        plan_code: session.planCode || null,
        photos: paths,
      };
      const ins = await rest("scalp_sessions", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(row),
      });
      if (!ins.ok) return res.status(500).json({ error: await ins.text() });
      return res.status(200).json({ ok: true, customerId });
    }

    /* ── 회차 조회 ──────────────────────────────────── */
    if (action === "history") {
      const q = `scalp_customers?name=eq.${encodeURIComponent(customer.name)}&phone4=eq.${encodeURIComponent(customer.phone4)}&select=id`;
      const found = await (await rest(q)).json();
      if (!Array.isArray(found) || !found.length) return res.status(200).json({ sessions: [] });
      const cid = found[0].id;

      const rows = await (
        await rest(`scalp_sessions?customer_id=eq.${cid}&order=round.asc&select=*`)
      ).json();

      // 사진은 1시간짜리 서명 URL로만 내보냅니다
      for (const r of rows) {
        const signed = {};
        for (const [region, path] of Object.entries(r.photos || {})) {
          const s = await fetch(`${URL_}/storage/v1/object/sign/${BUCKET}/${path}`, {
            method: "POST",
            headers: H,
            body: JSON.stringify({ expiresIn: 3600 }),
          });
          if (s.ok) {
            const j = await s.json();
            signed[region] = `${URL_}/storage/v1${j.signedURL || j.signedUrl}`;
          }
        }
        r.photoUrls = signed;
      }
      const cust = (await (await rest(`scalp_customers?id=eq.${cid}&select=enrolled_plan,enrolled_at`)).json())?.[0];
      return res.status(200).json({
        sessions: rows,
        enrolled: cust?.enrolled_plan ? { plan: cust.enrolled_plan, at: cust.enrolled_at } : null,
      });
    }

    /* ── 매장 설정 (디자이너 명단 · 플랜 가격 · PIN) ── */
    if (action === "getSettings") {
      const rows = await (await rest(`scalp_settings?key=eq.store&select=value`)).json();
      return res.status(200).json({ settings: rows?.[0]?.value || null });
    }

    if (action === "saveSettings") {
      const up = await rest("scalp_settings", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ key: "store", value: req.body.settings, updated_at: new Date().toISOString() }),
      });
      if (!up.ok) return res.status(500).json({ error: await up.text() });
      return res.status(200).json({ ok: true });
    }

    /* ── 고객 검색 · 상세 · 등록 플랜 ── */
    if (action === "searchCustomers") {
      const q = (req.body.q || "").trim();
      if (!q) return res.status(200).json({ customers: [] });
      const filter = `or=(name.ilike.*${encodeURIComponent(q)}*,phone4.ilike.*${encodeURIComponent(q)}*)`;
      const rows = await (
        await rest(`scalp_customers?${filter}&select=id,name,phone4,designer,enrolled_plan&order=created_at.desc&limit=30`)
      ).json();
      return res.status(200).json({ customers: Array.isArray(rows) ? rows : [] });
    }

    if (action === "customerDetail") {
      const cid = req.body.customerId;
      const rows = await (await rest(`scalp_sessions?customer_id=eq.${cid}&order=round.asc&select=*`)).json();
      for (const r of rows || []) {
        const signed = {};
        for (const [region, path] of Object.entries(r.photos || {})) {
          const s = await fetch(`${URL_}/storage/v1/object/sign/${BUCKET}/${path}`, {
            method: "POST",
            headers: H,
            body: JSON.stringify({ expiresIn: 3600 }),
          });
          if (s.ok) {
            const j = await s.json();
            signed[region] = `${URL_}/storage/v1${j.signedURL || j.signedUrl}`;
          }
        }
        r.photoUrls = signed;
      }
      return res.status(200).json({ sessions: rows || [] });
    }

    if (action === "setEnrollment") {
      const up = await rest(`scalp_customers?id=eq.${req.body.customerId}`, {
        method: "PATCH",
        body: JSON.stringify({
          enrolled_plan: req.body.plan || null,
          enrolled_at: req.body.plan ? new Date().toISOString() : null,
        }),
      });
      if (!up.ok) return res.status(500).json({ error: await up.text() });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "알 수 없는 action" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
