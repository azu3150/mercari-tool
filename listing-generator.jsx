import React, { useState, useRef, useMemo, useCallback } from "react";

// ---------- fixed template blocks (user's own boilerplate) ----------
const SHOP_NOTICE =
  "We offer immediate purchase approval. Our store deals exclusively in authentic products, so please feel confident in making your purchase.";
const HASHTAG_LINE = "#nico自分へのごほうび一覧 \n→他にも多数出品中!!";
const OTHER_NOTES = `＊ 自宅保管品になります。少しでも気になる点がありましたら、お気軽にコメント下さい^^*
＊ 素人撮影の為、小さな傷、汚れ等の見落としがある場合が御座います
＊ 色味、質感等に若干の違いがある場合も有ります。
＊匿名配送の範囲内でサイズにより発送方法の変更がある場合もあります。
(ヤマト→日本郵便 日本郵便→ヤマトなど)`;
const CLOSING = "スムーズなお取引を心がけております！\nよろしくお願い致します☆。.:＊・゜";

const RANKS = [
  { code: "S", label: "新品〜新品同様の商品" },
  { code: "AA", label: "中古品として良い" },
  { code: "A", label: "中古品としてまあまあ良い" },
  { code: "B", label: "中古品として普通" },
  { code: "C", label: "中古品として悪いがまだ使える" },
  { code: "D", label: "中古品として悪い(難ありを含む)" },
];

const SIZE_FIELDS = [
  { key: "height", label: "縦" },
  { key: "width", label: "横" },
  { key: "gusset", label: "マチ" },
  { key: "handle", label: "ハンドル" },
  { key: "shoulder", label: "ショルダー" },
];

function isCoachBrand(brand) {
  return /coach|コーチ/i.test(brand || "");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// iPhone photos can be several MB each; 5-6 of them in one request risks hitting
// payload-size limits. Downscale + re-compress to JPEG before sending to the API.
function fileToResizedBase64(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const scale = maxDim / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        resolve(dataUrl.split(",")[1]);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Call 1: image analysis only (no web search) -> titles/condition/accessories.
// Kept separate from research so each call's JSON fits well inside the token budget.
function buildVisionSystemPrompt(isCoach) {
  return `あなたはメルカリせどり(古着・ブランド品)出品のプロアシスタントです。
渡された商品画像とブランド名/補足情報から、以下のJSONだけを出力してください。前置きや説明文、Markdownのコードフェンスは一切つけないこと。できるだけ簡潔に。

タイトルルール:
${
  isCoach
    ? `- ブランドはCoachです。日本語タイトルと英語タイトルの両方を作る。
- それぞれ「40文字以内でSEO最適化したもの」と「65文字以内でSEO最適化したもの」の2パターンずつ、計4つ作る。`
    : `- Coach以外のブランドなので日本語タイトルのみ。
- 「40文字以内でSEO最適化したもの」と「65文字以内でSEO最適化したもの」の2パターン作る。`
}
- タイトルに入りきらないが検索に引っかかってほしいキーワードは keywords 配列に別出しする(最大5個)。

状態・付属品:
- 画像から見える傷、汚れ、使用感を簡潔に記述する。ただし画像だけでは判断しづらい点(内部の状態、匂いなど)は「要確認」と明記し、断定しない。
- 付属品は画像から判断できる範囲で一言で。

出力JSON形式(このキーのみ、他のキーは入れない):
{
  "titles": [{"label": "日本語 40字", "text": "..."}, ...],
  "keywords": ["...", "..."],
  "condition_assessment": "...",
  "condition_rank": "S|AA|A|B|C|D",
  "accessories": "..."
}`;
}

// Call 2: web research only (no images) -> sizes/price. Separate call keeps
// search + JSON comfortably within the token budget and avoids truncation.
function buildResearchSystemPrompt() {
  return `あなたはメルカリせどり出品のリサーチアシスタントです。web_searchツールを使って調べ、結果を以下のJSONだけで出力してください。前置きやMarkdownのコードフェンスは不要。簡潔に。

サイズ:
- 同一/類似商品を楽天市場などで検索し、縦・横・マチ・ハンドル・ショルダーストラップの実寸(cm)を調べる。ハンドルやショルダーが存在しない商品は空欄でよい。
- 見つからなければ空欄にし、size_note に「実寸は検索で見つからず、要確認」と書く。

価格:
- メルカリの同一/類似商品の売り切れ相場を調べ、提案価格(円, 数値のみ)・価格帯(例: "8000〜12000円")・根拠を1文で。

出力JSON形式(このキーのみ):
{
  "sizes": {"height": "", "width": "", "gusset": "", "handle": "", "shoulder": ""},
  "size_note": "...",
  "price": {"suggested": 0, "range": "...", "basis": "..."}
}`;
}

export default function ListingGenerator() {
  const [images, setImages] = useState([]); // {base64, mediaType, previewUrl}
  const [brand, setBrand] = useState("");
  const [productHint, setProductHint] = useState("");
  const [manageNo, setManageNo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [researchError, setResearchError] = useState("");
  const [researchLoading, setResearchLoading] = useState(false);
  const [testStatus, setTestStatus] = useState("");

  const runConnectionTest = async () => {
    setTestStatus("テスト中…");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 50,
          messages: [{ role: "user", content: "「テスト成功」と5文字だけ返して" }],
        }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const errBody = await res.json();
          detail = errBody?.error?.message || JSON.stringify(errBody);
        } catch {
          detail = await res.text().catch(() => "");
        }
        setTestStatus(`失敗 (${res.status}): ${detail}`);
        return;
      }
      const data = await res.json();
      const text = (data.content || []).find((b) => b.type === "text")?.text || "(応答なし)";
      setTestStatus("成功: " + text);
    } catch (e) {
      setTestStatus("失敗(例外): " + e.message);
    }
  };
  const [result, setResult] = useState(null);
  const [copiedKey, setCopiedKey] = useState("");
  const fileInputRef = useRef(null);

  const isCoach = isCoachBrand(brand);

  const handleFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList).slice(0, 6 - images.length);
    const converted = await Promise.all(
      files.map(async (file) => {
        const base64 = await fileToResizedBase64(file);
        const mediaType = "image/jpeg";
        return { base64, mediaType, previewUrl: `data:${mediaType};base64,${base64}` };
      })
    );
    setImages((prev) => [...prev, ...converted]);
  }, [images.length]);

  const removeImage = (idx) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  };

  const generate = async () => {
    setError("");
    if (images.length === 0) {
      setError("商品画像を1枚以上アップロードしてください");
      return;
    }
    if (!brand.trim()) {
      setError("ブランド名を入力してください");
      return;
    }
    setLoading(true);
    setResult(null);
    setResearchError("");

    const imageBlocks = images.slice(0, 3).map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    }));
    const userText = `ブランド名: ${brand}\n補足(商品名・型番など): ${productHint || "なし"}`;

    const callClaude = async (system, content, useSearch) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system,
          messages: [{ role: "user", content }],
          ...(useSearch ? { tools: [{ type: "web_search_20250305", name: "web_search" }] } : {}),
        }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const errBody = await res.json();
          detail = errBody?.error?.message || JSON.stringify(errBody);
        } catch {
          detail = await res.text().catch(() => "");
        }
        throw new Error(`APIエラー ${res.status}: ${detail}`);
      }
      const data = await res.json();
      const textBlocks = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const cleaned = textBlocks.replace(/```json|```/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("生成結果を読み取れませんでした: " + cleaned.slice(0, 200));
      return JSON.parse(jsonMatch[0]);
    };

    try {
      const visionResult = await callClaude(
        buildVisionSystemPrompt(isCoach),
        [...imageBlocks, { type: "text", text: userText }],
        false
      );
      setResult(visionResult);
    } catch (e) {
      console.error("vision call failed", e);
      setError("タイトル・状態の生成に失敗しました。(" + e.message + ")");
      setLoading(false);
      return;
    }
    setLoading(false);

    setResearchLoading(true);
    try {
      const researchResult = await callClaude(
        buildResearchSystemPrompt(),
        [{ type: "text", text: userText }],
        true
      );
      setResult((prev) => ({ ...prev, ...researchResult }));
    } catch (e) {
      console.error("research call failed", e);
      setResearchError("サイズ・価格のリサーチに失敗しました。(" + e.message + ")");
    } finally {
      setResearchLoading(false);
    }
  };

  const updateSize = (key, value) => {
    setResult((prev) => ({ ...prev, sizes: { ...prev.sizes, [key]: value } }));
  };

  const assembledDescription = useMemo(() => {
    if (!result) return "";
    const kwLine = [brand, productHint, ...(result.keywords || [])]
      .filter(Boolean)
      .join(" ");
    const rankObj = RANKS.find((r) => r.code === result.condition_rank);
    const rankBlock = RANKS.map((r) =>
      r.code === result.condition_rank
        ? `【 ${r.code} 】  ${r.label}`
        : `${r.code}　${r.label}`
    ).join("\n");
    const s = result.sizes || {};
    const sizeBlock = SIZE_FIELDS.map(
      (f) => `${f.label} 約  ${s[f.key] ? s[f.key] + "cm" : ""}`
    ).join("\n");

    return `${kwLine}

${SHOP_NOTICE} ${manageNo}

${HASHTAG_LINE}

●状態●
${result.condition_assessment || ""}

●付属品●
${result.accessories || ""}

●サイズ●平置き
${sizeBlock}

素人の寸法ですので、誤差はご了承ください。
${result.size_note ? "\n" + result.size_note : ""}

●状態ランク●
${rankBlock}

●その他●
${OTHER_NOTES}

${CLOSING}`;
  }, [result, brand, productHint, manageNo]);

  const copy = (text, key) => {
    navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(""), 1500);
  };

  return (
    <div style={styles.page}>
      <div style={styles.headerBar}>
        <div style={styles.tagHole} />
        <h1 style={styles.title}>出品タグ ジェネレーター</h1>
        <p style={styles.subtitle}>画像とブランド名から タイトル・説明文・価格を自動生成</p>
        <button style={styles.testBtn} onClick={runConnectionTest}>通信テスト</button>
        {testStatus && <p style={styles.testStatus}>{testStatus}</p>}
      </div>

      <div style={styles.card}>
        <label style={styles.label}>商品画像 (最大6枚・生成には先頭3枚を使用)</label>
        <div style={styles.imageRow}>
          {images.map((img, i) => (
            <div key={i} style={styles.thumbWrap}>
              <img src={img.previewUrl} alt="" style={styles.thumb} />
              <button style={styles.removeBtn} onClick={() => removeImage(i)}>×</button>
            </div>
          ))}
          {images.length < 6 && (
            <button style={styles.addTile} onClick={() => fileInputRef.current?.click()}>
              ＋
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />

        <label style={styles.label}>ブランド名</label>
        <input
          style={styles.input}
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
          placeholder="例: Coach / MARY QUANT"
        />

        <label style={styles.label}>補足 (商品名・型番など、任意)</label>
        <input
          style={styles.input}
          value={productHint}
          onChange={(e) => setProductHint(e.target.value)}
          placeholder="例: ボストンバッグ ピンソニックキルトデイジー"
        />

        <label style={styles.label}>管理番号 (任意)</label>
        <input
          style={styles.input}
          value={manageNo}
          onChange={(e) => setManageNo(e.target.value)}
          placeholder="例: 0703"
        />

        {error && <p style={styles.error}>{error}</p>}

        <button style={styles.generateBtn} onClick={generate} disabled={loading}>
          {loading ? "生成中…(画像を確認しています)" : "生成する"}
        </button>
      </div>

      {result && (
        <div style={styles.card}>
          <h2 style={styles.sectionTitle}>タイトル候補</h2>
          {(result.titles || []).map((t, i) => (
            <div key={i} style={styles.titleRow}>
              <div>
                <div style={styles.titleLabel}>{t.label}</div>
                <div style={styles.titleText}>{t.text}</div>
              </div>
              <button style={styles.copyBtn} onClick={() => copy(t.text, "title" + i)}>
                {copiedKey === "title" + i ? "済" : "コピー"}
              </button>
            </div>
          ))}

          <h2 style={styles.sectionTitle}>状態・付属品(確認して編集可)</h2>
          <textarea
            style={styles.textarea}
            value={result.condition_assessment || ""}
            onChange={(e) => setResult({ ...result, condition_assessment: e.target.value })}
          />
          <label style={styles.label}>状態ランク</label>
          <select
            style={styles.input}
            value={result.condition_rank}
            onChange={(e) => setResult({ ...result, condition_rank: e.target.value })}
          >
            {RANKS.map((r) => (
              <option key={r.code} value={r.code}>{r.code} - {r.label}</option>
            ))}
          </select>
          <input
            style={styles.input}
            value={result.accessories || ""}
            onChange={(e) => setResult({ ...result, accessories: e.target.value })}
            placeholder="付属品"
          />

          <h2 style={styles.sectionTitle}>サイズ (要確認・編集可)</h2>
          {researchLoading && <p style={styles.note}>サイズ・価格を検索中…</p>}
          {researchError && <p style={styles.error}>{researchError}</p>}
          <div style={styles.sizeGrid}>
            {SIZE_FIELDS.map((f) => (
              <div key={f.key} style={styles.sizeItem}>
                <span style={styles.sizeLabel}>{f.label}</span>
                <input
                  style={styles.sizeInput}
                  value={result.sizes?.[f.key] || ""}
                  onChange={(e) => updateSize(f.key, e.target.value)}
                  placeholder="cm"
                />
              </div>
            ))}
          </div>
          {result.size_note && <p style={styles.note}>{result.size_note}</p>}

          <h2 style={styles.sectionTitle}>価格提案 (要確認・編集可)</h2>
          <div style={styles.priceRow}>
            <span>¥</span>
            <input
              style={styles.priceInput}
              value={result.price?.suggested || ""}
              onChange={(e) =>
                setResult({ ...result, price: { ...result.price, suggested: e.target.value } })
              }
            />
          </div>
          <p style={styles.note}>相場: {result.price?.range} / 根拠: {result.price?.basis}</p>

          <h2 style={styles.sectionTitle}>組み立てた説明文</h2>
          <textarea style={styles.finalTextarea} value={assembledDescription} readOnly />
          <button style={styles.copyBtnFull} onClick={() => copy(assembledDescription, "desc")}>
            {copiedKey === "desc" ? "コピーしました" : "説明文をコピー"}
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#EFE7D8",
    fontFamily: "'Hiragino Sans', 'Noto Sans JP', sans-serif",
    color: "#2B2620",
    padding: "0 0 40px",
  },
  headerBar: {
    background: "#2B2620",
    color: "#EFE7D8",
    padding: "28px 20px 22px",
    position: "relative",
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
  },
  tagHole: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "#EFE7D8",
    marginBottom: 10,
  },
  title: { margin: 0, fontSize: 22, fontWeight: 800, letterSpacing: 0.5 },
  subtitle: { margin: "6px 0 0", fontSize: 13, opacity: 0.75 },
  testBtn: {
    marginTop: 14, fontSize: 12, padding: "6px 12px", borderRadius: 6,
    border: "1px solid #7A6F58", background: "transparent", color: "#EFE7D8", cursor: "pointer",
  },
  testStatus: { fontSize: 12, marginTop: 8, opacity: 0.9, wordBreak: "break-word" },
  card: {
    background: "#FFFDF8",
    margin: "16px 14px 0",
    padding: 18,
    borderRadius: 14,
    boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
    border: "1px solid #E4DBC8",
  },
  label: { display: "block", fontSize: 12, fontWeight: 700, color: "#7A6F58", margin: "14px 0 6px" },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "10px 12px",
    borderRadius: 8,
    border: "1px solid #D8CDB4",
    fontSize: 15,
    background: "#FBF8F1",
  },
  imageRow: { display: "flex", flexWrap: "wrap", gap: 8 },
  thumbWrap: { position: "relative", width: 72, height: 72 },
  thumb: { width: 72, height: 72, objectFit: "cover", borderRadius: 8, border: "1px solid #D8CDB4" },
  removeBtn: {
    position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%",
    border: "none", background: "#B23A2E", color: "#fff", fontSize: 12, cursor: "pointer",
  },
  addTile: {
    width: 72, height: 72, borderRadius: 8, border: "2px dashed #C9BC9E",
    background: "transparent", fontSize: 22, color: "#9A8C6C", cursor: "pointer",
  },
  error: { color: "#B23A2E", fontSize: 13, marginTop: 10 },
  generateBtn: {
    width: "100%", marginTop: 18, padding: "13px 0", borderRadius: 10, border: "none",
    background: "#B23A2E", color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
  },
  sectionTitle: {
    fontSize: 14, fontWeight: 800, color: "#2B2620", marginTop: 20, marginBottom: 8,
    borderLeft: "4px solid #B23A2E", paddingLeft: 8,
  },
  titleRow: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "8px 0", borderBottom: "1px dashed #E4DBC8", gap: 10,
  },
  titleLabel: { fontSize: 11, color: "#9A8C6C", fontWeight: 700 },
  titleText: { fontSize: 14, marginTop: 2 },
  copyBtn: {
    flexShrink: 0, fontSize: 12, padding: "6px 10px", borderRadius: 6,
    border: "1px solid #C9BC9E", background: "#FBF8F1", cursor: "pointer",
  },
  copyBtnFull: {
    width: "100%", marginTop: 10, padding: "12px 0", borderRadius: 10, border: "none",
    background: "#2B2620", color: "#EFE7D8", fontSize: 14, fontWeight: 700, cursor: "pointer",
  },
  textarea: {
    width: "100%", boxSizing: "border-box", minHeight: 90, padding: 10, borderRadius: 8,
    border: "1px solid #D8CDB4", fontSize: 14, fontFamily: "inherit", background: "#FBF8F1",
  },
  finalTextarea: {
    width: "100%", boxSizing: "border-box", minHeight: 260, padding: 12, borderRadius: 8,
    border: "1px solid #D8CDB4", fontSize: 13, fontFamily: "monospace", background: "#FBF8F1",
    whiteSpace: "pre-wrap",
  },
  sizeGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 },
  sizeItem: { display: "flex", alignItems: "center", gap: 8, background: "#FBF8F1", border: "1px solid #E4DBC8", borderRadius: 8, padding: "6px 10px" },
  sizeLabel: { fontSize: 12, color: "#7A6F58", width: 44, flexShrink: 0 },
  sizeInput: { border: "none", background: "transparent", fontSize: 14, width: "100%", fontFamily: "monospace" },
  note: { fontSize: 12, color: "#9A8C6C", marginTop: 6, lineHeight: 1.5 },
  priceRow: { display: "flex", alignItems: "center", gap: 6, fontSize: 20, fontWeight: 800, fontFamily: "monospace" },
  priceInput: {
    fontSize: 20, fontWeight: 800, fontFamily: "monospace", border: "none",
    borderBottom: "2px solid #B23A2E", background: "transparent", width: 140,
  },
};
