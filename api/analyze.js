// 두피 진단 회차 기록 저장/조회 — Supabase
const BUCKET = "scalp-photos";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const URL_ = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_KEY;
  if (!URL_ || !KEY) return res.status(501).json({ error: "Supabase 미설정" });

  const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const rest = (path, init = {}) =>
    fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });

  try {
    const { action, customer, session, photos } = req.body || {};

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
      const created = await (await rest("scalp_customers", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          name: customer.name,
          phone4: customer.phone4,
          designer: customer.designer || null,
          consent_at: new Date().toISOString(),
        }),
      })).json();
      return created?.[0]?.id;
    };

    if (action === "save") {
      const customerId = await findOrCreate();
      if (!customerId) return res.status(500).json({ error: "고객 등록 실패" });

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

    if (action === "history") {
      const q = `scalp_customers?name=eq.${encodeURIComponent(customer.name)}&phone4=eq.${encodeURIComponent(customer.phone4)}&select=id`;
      const found = await (await rest(q)).json();
      if (!Array.isArray(found) || !found.length) return res.status(200).json({ sessions: [] });
      const cid = found[0].id;

      const rows = await (await rest(`scalp_sessions?customer_id=eq.${cid}&order=round.asc&select=*`)).json();

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
      return res.status(200).json({ sessions: rows });
    }

    return res.status(400).json({ error: "알 수 없는 action" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
