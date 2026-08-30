/* ============================================================
   PRINTING THE OTHER DOCUMENTS

   Six documents — Quotation, Sales Order, Purchase Order, Selection Slip,
   Sales Return, Purchase Return — each built their own HTML in their own
   print function, with their own <style> block. None of them read the
   template a shop had designed for them in Print Management, and none of
   them carried an @page rule at all, so none of them had A4 or A5 either.
   A shop could spend an afternoon laying out a Sales Order template and
   print a document that looked at none of it.

   This is the one renderer they all use instead. It is driven by the same
   template config the bill uses — the same columns, widths, row heights,
   headings, title, terms, and the same With Rate / Without Rate rule.

   WHY A SEPARATE FILE, AND SELF-CONTAINED. It carries its own small
   helpers and its own stylesheet rather than reaching into app.js, for two
   reasons. The output has to work inside a popup print window, which is a
   different document with none of the app's CSS in it. And the bill's own
   print path is the one thing in this app that must not break — it is what
   every shop uses every day — so nothing here touches it.

   THE OLD LAYOUTS ARE NOT GONE. Each one survives in app.js as
   printQuotationLegacy(), printSalesOrderLegacy() and so on, unchanged and
   still callable — point a print button back at one and it prints exactly
   as it did before.

   That matters most for the Quotation, whose branded navy-and-gold layout
   was built to a design a shop asked for by name. It now prints through
   this renderer like the other five, so that it gains templates and a paper
   size; if the shop wants their design back it is one line.
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------- */
  /* small helpers, deliberately not borrowed from app.js              */
  /* ---------------------------------------------------------------- */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** Indian grouping, two decimals, no symbol — the symbol belongs in the
   *  totals box and the Amount column, not on every line. */
  function money(v) {
    var n = Number(v) || 0;
    return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /* ---------------------------------------------------------------- */
  /* what each document IS                                             */
  /* ---------------------------------------------------------------- */

  /**
   * One entry per printable document.
   *
   *   no / date      where the human document number and date live
   *   partyKind      which master the party comes from, so the caller
   *                  knows which list to look them up in
   *   partyId        the field holding it
   *   items          the lines, mapped onto the registry's field keys so
   *                  one cell renderer serves every document
   *   charges        named extras between subtotal and tax, which differ:
   *                  a Purchase Order has freight, a Sales Order transport
   *   extras         the key/value lines in the document box, top right
   *   tax            whether this document carries GST at all
   *
   * The keys used by `items` are the same ones server/printRegistry.js
   * declares, which is what lets a template designed there drive this.
   */
  var SPECS = {
    sales_quotation: {
      label: "Quotation", defaultTitle: "QUOTATION",
      no: function (d) { return d.quotation_no; },
      date: function (d) { return d.date; },
      partyKind: "customer", partyId: function (d) { return d.customer_id; },
      tax: true,
      items: goodsItems,
      charges: function (d) { return namedCharges(d, [["Transport", d.transport], ["Loading", d.loading]]); },
      extras: function (d) {
        return [
          d.valid_until ? ["Valid Until", d.valid_until] : null,
          d.sale_type ? ["Type", d.sale_type] : null
        ].filter(Boolean);
      },
      notes: function (d) { return [d.terms, d.remarks].filter(Boolean); }
    },

    sales_order: {
      label: "Sales Order", defaultTitle: "SALES ORDER",
      no: function (d) { return d.so_no; },
      date: function (d) { return d.date; },
      partyKind: "customer", partyId: function (d) { return d.customer_id; },
      tax: true,
      items: goodsItems,
      charges: function (d) { return namedCharges(d, [["Transport", d.transport], ["Loading", d.loading]]); },
      extras: function (d) {
        return [
          d.status ? ["Status", d.status] : null,
          d.expected_delivery_date ? ["Expected", d.expected_delivery_date] : null
        ].filter(Boolean);
      },
      /* The delivery address is a real instruction to whoever loads the
         lorry, so it prints. */
      notes: function (d) {
        return [d.delivery_address ? "Deliver to: " + d.delivery_address : null, d.remarks].filter(Boolean);
      }
    },

    purchase_order: {
      label: "Purchase Order", defaultTitle: "PURCHASE ORDER",
      no: function (d) { return d.po_no; },
      date: function (d) { return d.date; },
      partyKind: "supplier", partyId: function (d) { return d.supplier_id; },
      tax: true,
      items: goodsItems,
      /* A purchase order calls them freight and other charges, not
         transport and loading. Printing a supplier's document in a
         customer's vocabulary is the sort of thing that gets queried. */
      charges: function (d) { return namedCharges(d, [["Freight", d.freight], ["Other Charges", d.other_charges]]); },
      extras: function (d) {
        return [
          d.status ? ["Status", d.status] : null,
          d.expected_delivery_date ? ["Expected", d.expected_delivery_date] : null
        ].filter(Boolean);
      },
      notes: function (d) {
        return [
          d.delivery_address ? "Deliver to: " + d.delivery_address : null,
          d.payment_terms ? "Payment: " + d.payment_terms : null,
          d.delivery_terms ? "Delivery: " + d.delivery_terms : null,
          d.remarks
        ].filter(Boolean);
      }
    },

    /* The bill and the challan.

       Their PRINTING is not done here — that is renderInvoicePageContent()
       in app.js, which every shop uses daily and which nothing here
       touches. These entries exist so the same document can be turned into
       a WhatsApp message by the same code as the rest, rather than a
       second message builder drifting away from this one. */
    sales_invoice: {
      label: "Invoice", defaultTitle: "INVOICE",
      no: function (d) { return d.challan_no; },
      date: function (d) { return d.date; },
      partyKind: "customer", partyId: function (d) { return d.customer_id; },
      tax: true,
      items: goodsItems,
      charges: function (d) { return namedCharges(d, [["Transport", d.transport], ["Loading", d.loading]]); },
      extras: function () { return []; },
      notes: function (d) { return [d.remarks].filter(Boolean); }
    },

    delivery_challan: {
      label: "Delivery Challan", defaultTitle: "DELIVERY CHALLAN",
      no: function (d) { return d.challan_no; },
      date: function (d) { return d.date; },
      partyKind: "customer", partyId: function (d) { return d.customer_id; },
      /* A challan carries no GST — that is what makes it a challan and not
         a bill — so the totals block leaves the tax lines out entirely
         rather than printing them at zero. */
      tax: false,
      items: goodsItems,
      charges: function () { return []; },
      extras: function (d) {
        return [
          d.vehicle_number ? ["Vehicle", d.vehicle_number] : null,
          d.delivery_man ? ["Delivered by", d.delivery_man] : null
        ].filter(Boolean);
      },
      notes: function (d) { return [d.remarks].filter(Boolean); }
    },

    /* The seventh. Not in the original six, but it was the only document
       left in Print Management with a greyed-out Preview button once the
       others were done — and it carries exactly the same line shape, so
       leaving it out would have been an arbitrary hole. */
    purchase_invoice: {
      label: "Purchase Invoice", defaultTitle: "PURCHASE INVOICE",
      no: function (d) { return d.purchase_no; },
      date: function (d) { return d.date; },
      partyKind: "supplier", partyId: function (d) { return d.supplier_id; },
      tax: true,
      items: goodsItems,
      charges: function (d) {
        return namedCharges(d, [["Transport", d.transport], ["Loading", d.loading],
                                ["Other Charges", d.other_charges]]);
      },
      extras: function (d) {
        return [
          /* The SUPPLIER's own bill number. On a purchase this is the number
             that matters when the two of you disagree — yours is internal. */
          d.supplier_invoice_no ? ["Supplier Bill", d.supplier_invoice_no] : null,
          d.due_date ? ["Due", d.due_date] : null
        ].filter(Boolean);
      },
      notes: function (d) {
        return [
          d.transport_name ? "Transport: " + d.transport_name : null,
          d.vehicle_number ? "Vehicle: " + d.vehicle_number : null,
          d.lr_number ? "LR No.: " + d.lr_number : null,
          d.remarks
        ].filter(Boolean);
      }
    },

    sales_return: {
      label: "Sales Return", defaultTitle: "SALES RETURN",
      no: function (d) { return d.return_no; },
      date: function (d) { return d.date; },
      partyKind: "customer", partyId: function (d) { return d.customer_id; },
      tax: true,
      items: goodsItems,
      charges: function () { return []; },
      extras: function (d) {
        return [
          d.invoice_challan_no ? ["Against Bill", d.invoice_challan_no] : null,
          d.refund_method ? ["Refund", d.refund_method] : null
        ].filter(Boolean);
      },
      notes: function (d) { return [d.reason ? "Reason: " + d.reason : null].filter(Boolean); }
    },

    purchase_return: {
      label: "Purchase Return", defaultTitle: "PURCHASE RETURN",
      no: function (d) { return d.return_no; },
      date: function (d) { return d.date; },
      partyKind: "supplier", partyId: function (d) { return d.supplier_id; },
      tax: true,
      items: goodsItems,
      charges: function () { return []; },
      extras: function (d) {
        return [
          d.purchase_no ? ["Against Purchase", d.purchase_no] : null,
          d.refund_method ? ["Refund", d.refund_method] : null
        ].filter(Boolean);
      },
      notes: function (d) { return [d.reason ? "Reason: " + d.reason : null].filter(Boolean); }
    },

    /* The odd one out, and deliberately so. A selection slip is not a
       priced document: it records which designs a party picked, before any
       of it becomes a sale. No GST, no charges, and the quantity beside a
       line is usually still blank — which is why blanks print as a dash
       here rather than as 0. */
    selection_slip: {
      label: "Selection Slip", defaultTitle: "SELECTION SLIP",
      no: function (d) { return d.slip_no; },
      date: function (d) { return d.date; },
      /* Held on the slip itself rather than joined from the customer
         master: a slip is often written for somebody who is not a customer
         yet, which is the whole point of it. */
      partyKind: "inline",
      party: function (d) {
        return { name: d.customer_name || "—", phone: d.contact || "", address: d.site_address || "" };
      },
      tax: false,
      items: function (d) {
        return (d.items || []).map(function (it, i) {
          return {
            sn: it.sr_no != null ? it.sr_no : i + 1,
            code: it.design_no || "",
            name: it.description || "",
            qty: it.qty == null ? "" : String(it.qty),
            rate: it.rate == null ? null : num(it.rate),
            amount: it.amount == null ? null : num(it.amount),
            remarks: it.remark || ""
          };
        });
      },
      charges: function () { return []; },
      extras: function (d) {
        return [
          d.salesman ? ["Salesman", d.salesman] : null,
          d.referrer_name ? [d.referrer_type || "Referred by", d.referrer_name] : null
        ].filter(Boolean);
      },
      notes: function () { return []; }
    }
  };

  /** Charges that are actually charged. A row reading "Transport 0.00" is
   *  noise on a document somebody has to read. */
  function namedCharges(doc, pairs) {
    return pairs
      .filter(function (p) { return num(p[1]) > 0; })
      .map(function (p) { return { label: p[0], value: num(p[1]) }; });
  }

  /**
   * The five goods documents all carry the invoice's line shape, so they
   * share one mapping onto the registry's field keys.
   */
  /**
   * @param enrich  optional, supplied by the caller: given a raw line, it
   *   returns the fields the line does not carry itself.
   *
   *   These documents store size_id but SIZE_LABEL EMPTY — only a Purchase
   *   Order fills it in. So a Size column printed blank on a Quotation, a
   *   Sales Order and both Returns, which the old print functions did too
   *   (they read it.size_label and got ""). The label is one lookup away in
   *   the product, and the bill has always done exactly this fallback for
   *   HSN, code and brand. Same idea, same reason: the LINE's own value
   *   wins where it has one, because a document must keep printing what it
   *   was actually raised with — but a blank preserves no history, so it
   *   falls back to the product rather than printing nothing.
   */
  function goodsItems(doc, enrich) {
    return (doc.items || []).map(function (it, i) {
      var ex = enrich ? (enrich(it) || {}) : {};
      var qty = num(it.qty), rate = num(it.rate);
      var disc = num(it.discount_amount);
      var net = round2(qty * rate - disc);
      var gstPct = num(it.gst_rate);
      return {
        sn: i + 1,
        name: it.name || "",
        code: it.code || ex.code || "",
        hsn: it.hsn_code || ex.hsn || "",
        brand: it.brand || ex.brand || "",
        category: it.category || ex.category || "",
        size: it.size_label || ex.size || "",
        length: num(it.length_ft) > 0 ? String(round2(it.length_ft)) : "",
        width: num(it.width_val) > 0 ? String(round2(it.width_val)) : "",
        thickness: num(it.thickness_in) > 0 ? String(round2(it.thickness_in)) : "",
        /* Pieces is the physical count and qty is what was billed — on a
           square-foot line those differ, and the piece count is the one a
           person checks against the lorry. Shown together when they do. */
        qty: it.pieces != null && num(it.pieces) !== qty
          ? String(round2(qty)) + " (" + it.pieces + " pc)"
          : String(round2(qty)),
        unit: it.unit_label || ex.unit || "",
        rate: rate,
        disc: disc > 0 ? disc : null,
        taxable: net,
        gstPct: gstPct,
        cgst: round2(net * gstPct / 200),
        sgst: round2(net * gstPct / 200),
        igst: round2(net * gstPct / 100),
        amount: net,
        remarks: it.remarks || ""
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* one cell                                                          */
  /* ---------------------------------------------------------------- */

  var MONEY_KEYS = { rate: 1, disc: 1, taxable: 1, cgst: 1, sgst: 1, igst: 1, amount: 1 };
  var NUM_KEYS = { sn: 1, qty: 1, rate: 1, disc: 1, taxable: 1, gstPct: 1, cgst: 1, sgst: 1, igst: 1, amount: 1, length: 1, width: 1, thickness: 1 };

  /**
   * Without Rate BLANKS the money cells rather than removing them.
   *
   * The same rule the bill has always followed: the column stays so the
   * ruling still lines up and staff can write figures in by hand, and the
   * cell is empty rather than showing 0.00 — a zero is a claim that the
   * thing was free, which is a different statement from "not priced here".
   */
  function cellFor(key, item, showRate) {
    var v = item[key];
    if (v == null || v === "") {
      // A selection slip's unpriced lines read as a dash, not as blank:
      // blank looks like the slip was printed wrong.
      return (key === "qty" || key === "rate" || key === "amount") && v === null ? "&mdash;" : "";
    }
    if (MONEY_KEYS[key]) return showRate ? money(v) : "";
    if (key === "gstPct") return v ? v + "%" : "";
    return esc(v);
  }

  /* ---------------------------------------------------------------- */
  /* the page                                                          */
  /* ---------------------------------------------------------------- */

  /** Paper in millimetres, honouring a template's custom size and
   *  orientation — the thing none of these six documents had at all. */
  function paperMm(cfg, fallback) {
    var w, h;
    var paper = (cfg && cfg.paper) || fallback || "A4";
    if (paper === "custom" && num(cfg.paperW) > 0 && num(cfg.paperH) > 0) {
      w = num(cfg.paperW); h = num(cfg.paperH);
    } else if (paper === "A5") { w = 148; h = 210; }
    else { w = 210; h = 297; }
    return (cfg && cfg.orientation === "landscape")
      ? { w: h, h: w, orientation: "landscape", named: paper === "custom" ? null : paper }
      : { w: w, h: h, orientation: "portrait", named: paper === "custom" ? null : paper };
  }

  /** The row height for one row: its own if the designer dragged that one,
   *  then whatever every row shares, then whatever the text needs. Same
   *  order the bill resolves it in, deliberately. */
  function rowHeight(cfg, i) {
    var map = (cfg && cfg.rowHeights) || {};
    var own = num(map[i]);
    if (own > 0) return Math.min(120, own);
    var all = num(cfg && cfg.rowHeight);
    return all > 0 ? Math.min(120, all) : 0;
  }

  /**
   * Build the printable page for one document.
   *
   * @param docKey   which of SPECS
   * @param doc      the document, items included
   * @param opts     { settings, party, config, showRate }
   *                 party is looked up by the caller, which owns the
   *                 customer and supplier lists; passing it in keeps this
   *                 file free of app state.
   */
  function buildDocHtml(docKey, doc, opts) {
    opts = opts || {};
    var spec = SPECS[docKey];
    if (!spec) throw new Error("No print spec for " + docKey);

    var cfg = opts.config || {};
    var s = opts.settings || {};
    var showRate = opts.showRate !== false && cfg.showRate !== 0;
    var items = spec.items(doc, opts.enrich);
    var party = spec.partyKind === "inline" ? spec.party(doc) : (opts.party || null);

    /* Columns come from the template, filtered to what this document can
       actually fill. A template offering a GST column on a selection slip
       would print an empty stripe down the page. */
    var cols = (cfg.columns || []).filter(function (c) { return c && c.show; });
    if (!cols.length) cols = defaultColumns(docKey, spec);
    if (!spec.tax) {
      cols = cols.filter(function (c) {
        return c.key !== "gstPct" && c.key !== "cgst" && c.key !== "sgst" && c.key !== "igst" && c.key !== "taxable";
      });
    }
    if (!showRate) {
      // The columns STAY (see cellFor) — this only drops ones that would be
      // meaningless even blank.
      cols = cols.filter(function (c) { return c.key !== "gstPct"; });
    }

    var totals = buildTotals(docKey, doc, spec, items, showRate);

    var head = cols.map(function (c) {
      return '<th class="' + (NUM_KEYS[c.key] ? "n" : "") + '"' +
        (num(c.width) > 0 ? ' style="width:' + num(c.width) + 'px"' : "") +
        ">" + esc(c.label || c.key) + "</th>";
    }).join("");

    var body = items.map(function (it, i) {
      var h = rowHeight(cfg, i);
      return '<tr' + (h ? ' style="height:' + h + 'px"' : "") + ">" +
        cols.map(function (c) {
          return '<td class="' + (NUM_KEYS[c.key] ? "n" : "") + '"' +
            (c.align ? ' style="text-align:' + c.align + '"' : "") + ">" +
            cellFor(c.key, it, showRate) + "</td>";
        }).join("") + "</tr>";
    }).join("");

    var notes = (spec.notes ? spec.notes(doc) : []).concat(
      cfg.terms ? [cfg.terms] : []).concat(cfg.customText ? [cfg.customText] : []);

    var extras = spec.extras ? spec.extras(doc) : [];
    var paper = paperMm(cfg, "A4");

    var bank = [s.bank_name, s.bank_account_no && "A/c " + s.bank_account_no,
      s.bank_ifsc && "IFSC " + s.bank_ifsc, s.bank_branch].filter(Boolean);

    var html =
      '<div class="dp-page' + (cfg.showBorders === 0 ? " dp-norules" : "") + '">' +
      (cfg.header ? '<div class="dp-headline">' + esc(cfg.header) + "</div>" : "") +
      '<div class="dp-banner">' + esc((cfg.title || "").trim() || spec.defaultTitle) + "</div>" +

      (cfg.showCompany === 0 ? "" :
        '<div class="dp-shop">' +
        (cfg.showLogo !== 0 && s.logo_data ? '<img class="dp-logo" src="' + s.logo_data + '" alt="">' : "") +
        '<div class="dp-shop-name">' + esc(s.business_name || "") + "</div>" +
        (s.tagline ? '<div class="dp-tag">' + esc(s.tagline) + "</div>" : "") +
        (s.address ? '<div class="dp-addr">' + esc(s.address) + "</div>" : "") +
        '<div class="dp-contact">' + [
          s.gstin ? "GSTIN: " + esc(s.gstin) : "",
          s.phones ? "Ph: " + esc(s.phones) : ""
        ].filter(Boolean).join("  |  ") + "</div></div>") +

      (cfg.showParty === 0 ? "" :
        '<div class="dp-parties"><div class="dp-party">' +
        '<div class="dp-label">' + (spec.partyKind === "supplier" ? "Supplier" : "Party") + "</div>" +
        '<div class="dp-party-name">' + esc(party && party.name ? party.name : "—") + "</div>" +
        (party && party.address ? "<div>" + esc(party.address) + "</div>" : "") +
        (party && party.phone ? "<div>Mobile: " + esc(party.phone) + "</div>" : "") +
        (party && party.gst ? "<div>GSTIN: " + esc(party.gst) + "</div>" : "") +
        '</div><div class="dp-doc">' +
        kv("No.", spec.no(doc)) + kv("Date", spec.date(doc)) +
        extras.map(function (e) { return kv(e[0], e[1]); }).join("") +
        "</div></div>") +

      '<div class="dp-table-wrap"><table class="dp-table"><thead><tr>' + head +
      "</tr></thead><tbody>" + (body || emptyRow(cols.length)) + "</tbody></table></div>" +

      '<div class="dp-lower"><div class="dp-notes">' +
      notes.map(function (n) { return "<div>" + esc(n) + "</div>"; }).join("") +
      (bank.length && cfg.showTotals !== 0
        ? '<div class="dp-bank"><b>Bank Details</b><br>' + bank.map(esc).join("<br>") + "</div>" : "") +
      "</div>" +
      (cfg.showTotals === 0 || !totals.rows.length ? "<div></div>" :
        '<div class="dp-totals">' +
        totals.rows.map(function (r) {
          return '<div class="dp-tr' + (r.grand ? " dp-grand" : "") + '"><span>' + esc(r.label) +
            "</span><span>" + (showRate ? r.value : "") + "</span></div>";
        }).join("") + "</div>") +
      "</div>" +

      (cfg.showSignature === 0 ? "" :
        '<div class="dp-sign"><span>Receiver’s Signature</span><span>For ' +
        esc(s.business_name || "") + "<br>" + esc(cfg.signatureText || "Authorised Signature") +
        "</span></div>") +

      (cfg.footer ? '<div class="dp-footline">' + esc(cfg.footer) + "</div>" : "") +
      "</div>";

    return { html: html, css: CSS, paper: paper };
  }

  function kv(k, v) {
    return '<div class="dp-kv"><span>' + esc(k) + "</span><b>" + esc(v == null ? "" : v) + "</b></div>";
  }

  function emptyRow(n) {
    return '<tr><td colspan="' + n + '" style="text-align:center;padding:14px;color:#777">No items on this document.</td></tr>';
  }

  /** A column set for a document whose template has nothing switched on —
   *  which is what a shop that has never opened the Designer has. */
  function defaultColumns(docKey, spec) {
    if (docKey === "selection_slip") {
      return [
        { key: "sn", label: "Sr. No." }, { key: "code", label: "Design No." },
        { key: "name", label: "Description" }, { key: "qty", label: "Qty" },
        { key: "rate", label: "Rate" }, { key: "amount", label: "Amount" },
        { key: "remarks", label: "Note" }
      ];
    }
    return [
      { key: "sn", label: "Sr No." }, { key: "name", label: "Product" },
      { key: "size", label: "Size" }, { key: "unit", label: "Unit" },
      { key: "qty", label: "Qty" }, { key: "rate", label: "Rate" },
      { key: "amount", label: "Amount" }
    ];
  }

  function buildTotals(docKey, doc, spec, items, showRate) {
    var rows = [];
    if (!showRate) return { rows: rows };

    if (docKey === "selection_slip") {
      var any = items.some(function (i) { return i.amount != null; });
      if (!any) return { rows: rows };
      var sum = items.reduce(function (a, i) { return a + num(i.amount); }, 0);
      rows.push({ label: "Total", value: "₹" + money(sum), grand: true });
      return { rows: rows };
    }

    rows.push({ label: "Sub Total", value: money(doc.subtotal) });
    if (num(doc.discount_amount) > 0) rows.push({ label: "Discount", value: "-" + money(doc.discount_amount) });
    (spec.charges(doc) || []).forEach(function (c) {
      rows.push({ label: c.label, value: money(c.value) });
    });
    if (spec.tax) {
      if (doc.tax_type === "IGST") {
        if (num(doc.igst)) rows.push({ label: "IGST", value: money(doc.igst) });
      } else {
        if (num(doc.cgst)) rows.push({ label: "CGST", value: money(doc.cgst) });
        if (num(doc.sgst)) rows.push({ label: "SGST", value: money(doc.sgst) });
      }
    }
    rows.push({ label: "Grand Total", value: "₹" + money(doc.total), grand: true });
    return { rows: rows };
  }

  /* ---------------------------------------------------------------- */
  /* the same document, as a WhatsApp message                          */
  /* ---------------------------------------------------------------- */

  /**
   * The document as text, for WhatsApp.
   *
   * Built from the SAME spec the printed page uses, so the message and the
   * paper can never quote different figures for the same order — which is
   * the one thing that would make a shop stop trusting either.
   *
   * WhatsApp understands *bold* and nothing else useful; there is no table,
   * no monospace that survives, and no reliable alignment. So each line is
   * its own indented block rather than a column layout that would arrive
   * ragged on a narrow phone.
   */
  function docMessage(docKey, doc, opts) {
    opts = opts || {};
    var spec = SPECS[docKey];
    if (!spec) throw new Error("No message spec for " + docKey);
    var s = opts.settings || {};
    var showRate = opts.showRate !== false;
    var items = spec.items(doc, opts.enrich);
    var party = spec.partyKind === "inline" ? spec.party(doc) : (opts.party || null);
    var shop = s.business_name || "";

    var L = [];
    L.push("*" + (shop ? shop.toUpperCase() + " — " : "") + spec.defaultTitle + "*");
    L.push("");
    L.push(spec.label + " No: " + (spec.no(doc) || "—"));
    L.push("Date: " + (spec.date(doc) || "—"));

    (spec.extras ? spec.extras(doc) : []).forEach(function (e) { L.push(e[0] + ": " + e[1]); });

    L.push("");
    L.push("Customer:");
    L.push(party && party.name ? party.name : "—");
    L.push("");
    L.push("*Items:*");
    L.push("");

    items.forEach(function (it, i) {
      /* Name and size on one line: on a phone they read as one product,
         and a size on its own line looks like a second item. */
      L.push((i + 1) + ". " + [it.name, it.size].filter(Boolean).join(" — "));
      var qty = "   Qty: " + it.qty + (it.unit ? " " + it.unit : "");
      L.push(qty);
      if (showRate && it.rate != null) L.push("   Rate: " + rupee(it.rate));
      if (showRate && it.amount != null) L.push("   Amount: " + rupee(it.amount));
    });

    if (showRate) {
      var rows = buildTotals(docKey, doc, spec, items, true).rows;
      if (rows.length) {
        L.push("");
        L.push("--------------------------------");
        rows.forEach(function (r) {
          /* The grand total in bold, because it is the line the customer
             is actually looking for. buildTotals already put the rupee
             symbol on it, so it is not added twice. */
          var v = /^₹/.test(r.value) ? r.value : "₹" + r.value;
          L.push(r.grand ? ("*" + r.label + ": " + v + "*") : (r.label + ": " + v));
        });
      }
    }

    (spec.notes ? spec.notes(doc) : []).forEach(function (n) {
      L.push(""); L.push(n);
    });

    L.push("");
    L.push("Thank you,");
    L.push(shop || "");
    return L.filter(function (x) { return x !== undefined; }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function rupee(v) { return "₹" + money(v); }

  /* ---------------------------------------------------------------- */
  /* the stylesheet                                                    */
  /* ---------------------------------------------------------------- */

  /* Matches the bill: one ink in three weights, a hairline grid, tabular
     figures. PLAIN HEX ONLY — this markup is also rasterised by
     html2canvas, which throws on oklch(). */
  var CSS = [
    '.dp-page{background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;',
    '  font-size:11px;line-height:1.45;font-variant-numeric:tabular-nums;',
    '  display:flex;flex-direction:column;}',
    '.dp-headline{text-align:center;font-size:10px;padding-bottom:3px;}',
    '.dp-banner{text-align:center;font-weight:800;font-size:15px;letter-spacing:.16em;',
    '  border-bottom:1px solid #000;padding-bottom:4px;margin-bottom:3px;}',
    '.dp-shop{text-align:center;border-bottom:1px solid #000;padding-bottom:4px;margin-bottom:4px;}',
    '.dp-logo{max-width:60px;max-height:60px;}',
    '.dp-shop-name{font-size:18px;font-weight:800;letter-spacing:-.005em;}',
    '.dp-tag{font-size:10px;font-style:italic;color:#555;}',
    '.dp-addr{font-size:10px;color:#333;margin-top:1px;}',
    '.dp-contact{font-size:9.5px;font-weight:700;margin-top:2px;}',
    '.dp-parties{display:flex;border:1px solid #000;font-size:10px;}',
    '.dp-party{flex:1;padding:5px 8px;border-right:1px solid #000;}',
    '.dp-doc{flex:0 0 40%;padding:5px 8px;}',
    '.dp-label{font-weight:800;font-size:8.5px;text-transform:uppercase;',
    '  letter-spacing:.09em;color:#555;margin-bottom:2px;}',
    '.dp-party-name{font-weight:800;font-size:12px;margin-bottom:2px;}',
    '.dp-kv{display:flex;justify-content:space-between;gap:8px;}',
    '.dp-kv span{color:#555;}.dp-kv b{font-weight:800;}',
    '.dp-table-wrap{border:1px solid #000;border-top:none;flex:1 0 auto;}',
    'table.dp-table{width:100%;border-collapse:collapse;font-size:10px;table-layout:fixed;}',
    'table.dp-table th{background:#f2f2f2;color:#000;text-align:left;font-size:9px;',
    '  text-transform:uppercase;letter-spacing:.06em;font-weight:800;padding:4px 5px;',
    '  border:1px solid #000;}',
    'table.dp-table td{padding:4px 5px;border:1px solid #c9c9c9;vertical-align:top;',
    '  overflow-wrap:anywhere;}',
    'table.dp-table td:first-child{border-left-color:#000;}',
    'table.dp-table td:last-child{border-right-color:#000;}',
    'table.dp-table th.n,table.dp-table td.n{text-align:right;white-space:nowrap;',
    '  overflow-wrap:normal;}',
    '.dp-page.dp-norules table.dp-table th,.dp-page.dp-norules table.dp-table td,',
    '.dp-page.dp-norules .dp-parties{border:none;}',
    '.dp-lower{display:flex;border:1px solid #000;border-top:none;font-size:9.5px;}',
    '.dp-notes{flex:1;padding:5px 8px;border-right:1px solid #000;line-height:1.55;}',
    '.dp-bank{margin-top:5px;}',
    '.dp-totals{flex:0 0 42%;font-size:10px;}',
    '.dp-tr{display:flex;justify-content:space-between;padding:2px 8px;border-bottom:1px solid #ddd;}',
    '.dp-tr:last-child{border-bottom:none;}',
    '.dp-grand{font-weight:800;font-size:12.5px;border-top:1.5px solid #000;background:#f2f2f2;}',
    '.dp-sign{display:flex;justify-content:space-between;gap:8px;border:1px solid #000;',
    '  border-top:none;padding:22px 8px 6px;}',
    '.dp-sign span{flex:1;border-top:1px solid #000;padding-top:3px;font-size:9px;',
    '  text-align:center;color:#333;}',
    '.dp-footline{text-align:center;font-style:italic;margin-top:6px;font-size:10px;}'
  ].join("\n");

  /* ---------------------------------------------------------------- */

  global.DocPrint = {
    SPECS: SPECS,
    build: buildDocHtml,
    message: docMessage,
    paperMm: paperMm,
    CSS: CSS,
    /** A complete standalone document, for the popup print window. */
    page: function (docKey, doc, opts) {
      var built = buildDocHtml(docKey, doc, opts);
      var p = built.paper;
      var size = p.named ? p.named + " " + p.orientation : p.w + "mm " + p.h + "mm";
      var margin = p.h > 250 ? 6 : 3;
      return "<!doctype html><html><head><meta charset=\"utf-8\"><title>" +
        esc(SPECS[docKey].label + " " + (SPECS[docKey].no(doc) || "")) + "</title><style>" +
        "@page{size:" + size + ";margin:" + margin + "mm;}" +
        "body{margin:0;background:#e9ecf1;}" +
        ".dp-sheet{width:" + p.w + "mm;min-height:" + (p.h - margin * 2) + "mm;margin:10mm auto;" +
        "background:#fff;padding:" + (num(opts && opts.config && opts.config.margins && opts.config.margins.top) || 8) + "mm;" +
        "box-shadow:0 1px 6px rgba(0,0,0,.2);box-sizing:border-box;display:flex;flex-direction:column;}" +
        "@media print{body{background:#fff;}.dp-sheet{width:auto;margin:0;box-shadow:none;padding:0;}}" +
        built.css + "</style></head><body><div class=\"dp-sheet\">" + built.html +
        "</div></body></html>";
    }
  };
})(window);
