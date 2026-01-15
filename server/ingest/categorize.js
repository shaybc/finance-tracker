function parseTagIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => Number(item)).filter((item) => !Number.isNaN(item));
      }
    } catch {
      // ignore parse errors
    }
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => Number(item))
      .filter((item) => !Number.isNaN(item));
  }
  return [];
}

function applyRuleToTx(db, tx, rule) {
  console.log(`  Testing rule "${rule.name}": field=${rule.match_field}, type=${rule.match_type}, pattern="${rule.pattern}"`);
  const runOnCategorized = Boolean(rule.run_on_categorized);

  if (tx.category_id && !runOnCategorized) {
    console.log(`    Skipped: transaction already categorized`);
    return false;
  }
  
  // Check source filter
  if (rule.source) {
    const isCreditSource = rule.source === "כ.אשראי";
    const matchesSource = isCreditSource
      ? String(tx.source || "").startsWith("כ.אשראי")
      : rule.source === tx.source;
    if (!matchesSource) {
      console.log(`    Skipped: source filter (rule wants ${rule.source}, tx is ${tx.source})`);
      return false;
    }
  }
  
  // Check direction filter
  if (rule.direction && rule.direction !== tx.direction) {
    console.log(`    Skipped: direction filter (rule wants ${rule.direction}, tx is ${tx.direction})`);
    return false;
  }

  const absAmount = Math.abs(Number(tx.amount_signed ?? 0));
  if (rule.amount_min != null && absAmount < Number(rule.amount_min)) {
    console.log(`    Skipped: amount min filter (rule wants >= ${rule.amount_min}, tx is ${absAmount})`);
    return false;
  }
  if (rule.amount_max != null && absAmount > Number(rule.amount_max)) {
    console.log(`    Skipped: amount max filter (rule wants <= ${rule.amount_max}, tx is ${absAmount})`);
    return false;
  }

  // Get the field values to match against
  const fieldValues = [];
  
  if (rule.match_field === "merchant") {
    // For "תיאור/בית עסק": use merchant if exists, otherwise use description
    if (tx.merchant) {
      fieldValues.push(tx.merchant);
    }
    if (tx.description && tx.description !== tx.merchant) {
      fieldValues.push(tx.description);
    }
  } else if (rule.match_field === "category_raw") {
    if (tx.category_raw) {
      fieldValues.push(tx.category_raw);
    }
  }

  // Skip if field is empty
  if (fieldValues.length === 0) {
    console.log(`    Skipped: no field value to search`);
    return false;
  }

  console.log(`    Searching in field values: "${fieldValues.join(" | ")}"`);

  // Normalize pattern once for comparison
  const normalizedPattern = String(rule.pattern)
    .trim()
    .normalize("NFC")
    .toLowerCase();

  console.log(`    Normalized pattern: "${normalizedPattern}"`);

  let matched = false;

  if (rule.match_type === "regex") {
    try {
      // For regex, match against original field values (not normalized),
      // so patterns can match substrings naturally.
      // Unicode flag 'u' is important for proper Hebrew handling.
      const pattern = String(rule.pattern).normalize("NFC");
      const re = new RegExp(pattern, "iu");
      matched = fieldValues.some((value) => {
        const normalizedValue = String(value).normalize("NFC").trim();
        return re.test(normalizedValue);
      });
      console.log(`    Regex check: ${matched}`);
    } catch (err) {
      console.error(`    Invalid regex pattern: ${rule.pattern}`, err);
      matched = false;
    }
  } else {
    matched = fieldValues.some((value) => {
      const normalizedField = String(value)
        .trim()
        .normalize("NFC")
        .toLowerCase();
      console.log(`    Normalized field: "${normalizedField}"`);
      if (rule.match_type === "contains") {
        return normalizedField.includes(normalizedPattern);
      }
      if (rule.match_type === "equals") {
        return normalizedField === normalizedPattern;
      }
      return false;
    });
    console.log(`    ${rule.match_type === "contains" ? "Contains" : "Equals"} check: ${matched}`);
  }

  if (matched) {
    let updated = false;

    if (rule.category_id && (runOnCategorized || !tx.category_id)) {
      if (tx.category_id !== rule.category_id) {
        db.prepare("UPDATE transactions SET category_id = ? WHERE id = ?").run(
          rule.category_id,
          tx.id
        );
        console.log(`    ✓ MATCHED! Applied category ${rule.category_name} to transaction ${tx.id}`);
        updated = true;
      }
    }

    const ruleTagIds = parseTagIds(rule.tag_ids);
    if (ruleTagIds.length > 0) {
      const existingTagIds = new Set(parseTagIds(tx.tags));
      const nextTagIds = new Set(existingTagIds);
      ruleTagIds.forEach((tagId) => nextTagIds.add(tagId));
      if (nextTagIds.size !== existingTagIds.size) {
        db.prepare("UPDATE transactions SET tags = ? WHERE id = ?").run(
          JSON.stringify(Array.from(nextTagIds)),
          tx.id
        );
        console.log(`    ✓ MATCHED! Applied ${ruleTagIds.length} tags to transaction ${tx.id}`);
        updated = true;
      }
    }

    if (updated) {
      if (rule.id) {
        db.prepare("UPDATE rules SET applied_count = applied_count + 1 WHERE id = ?").run(rule.id);
      }
      return true;
    }
  }
  
  console.log(`    No match for this rule`);
  return false;
}

export function applySingleRuleToTransaction(db, txId, rule) {
  const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);
  if (!tx) return false;

  console.log(`Checking transaction ${txId}: merchant="${tx.merchant}", description="${tx.description}", source="${tx.source}"`);
  return applyRuleToTx(db, tx, rule);
}

export function applyRulesToTransaction(db, txId) {
  const tx = db.prepare("SELECT * FROM transactions WHERE id = ?").get(txId);
  if (!tx) return false;

  console.log(`Checking transaction ${txId}: merchant="${tx.merchant}", description="${tx.description}", source="${tx.source}"`);

  const rules = db
    .prepare(
      "SELECT r.*, c.name_he AS category_name FROM rules r LEFT JOIN categories c ON c.id = r.category_id WHERE r.enabled = 1 ORDER BY r.run_on_categorized ASC, r.id ASC"
    )
    .all();

  const normalRules = [];
  const runOnCategorizedRules = [];
  for (const rule of rules) {
    if (rule.run_on_categorized) {
      runOnCategorizedRules.push(rule);
    } else {
      normalRules.push(rule);
    }
  }

  let updated = false;
  for (const rule of normalRules) {
    if (applyRuleToTx(db, tx, rule)) {
      updated = true;
      break;
    }
  }

  for (const rule of runOnCategorizedRules) {
    if (applyRuleToTx(db, tx, rule)) {
      updated = true;
      break;
    }
  }

  if (!updated) {
    console.log(`  No rules matched transaction ${txId}`);
  }
  return updated;
}
