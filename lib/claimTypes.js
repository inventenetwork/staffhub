'use strict';

// Single source of truth for the claims category/subcategory catalog, used
// both server-side (validation, labels, limit lookups) and rendered into the
// page as JSON so the claim form's JS can build the right fields per
// category/subcategory without a page reload.
//
// - `mileage` is the only subcategory with a server-computed, locked amount
//   (distance × rate); every other subcategory takes a flat amount.
// - `medicalLimitField` links a medical subcategory to its columns on the
//   medical_limits table (see db/schema.sql) and its Company Settings key
//   (see lib/settings.js DEFAULTS) for the annual-limit check.
const CLAIM_CATEGORIES = {
  travel: {
    label: 'Travel',
    subcategories: {
      accommodation: { label: 'Accommodation' },
      mileage: { label: 'Mileage' },
      air_ticket: { label: 'Air Ticket' },
      toll: { label: 'Toll' },
      parking: { label: 'Parking' },
      travel_allowance: { label: 'Travel Allowance' },
    },
  },
  medical: {
    label: 'Medical',
    hasDependent: true, // claims can be for the employee or a dependent
    subcategories: {
      outpatient: { label: 'Outpatient', medicalLimitField: 'outpatient' },
      dental: { label: 'Dental', medicalLimitField: 'dental' },
      optical: { label: 'Optical', medicalLimitField: 'optical' },
      hospitalization: { label: 'Hospitalization', medicalLimitField: 'hospitalization' },
    },
  },
  general: {
    label: 'General Expenses',
    subcategories: {
      meals_entertainment: { label: 'Meals & Entertainment' },
      office_supplies: { label: 'Office Supplies' },
      wfh_allowance: { label: 'WFH Allowance' },
    },
  },
  benefits: {
    label: 'Benefits',
    subcategories: {
      wellness: { label: 'Wellness' },
      professional_development: { label: 'Professional Development' },
    },
  },
};

const CATEGORY_KEYS = Object.keys(CLAIM_CATEGORIES);

function isValidCategory(category) {
  return CATEGORY_KEYS.includes(category);
}

function isValidSubcategory(category, subcategory) {
  const cat = CLAIM_CATEGORIES[category];
  return !!cat && !!cat.subcategories[subcategory];
}

function subcategoryLabel(category, subcategory) {
  const cat = CLAIM_CATEGORIES[category];
  const sub = cat && cat.subcategories[subcategory];
  return sub ? sub.label : subcategory;
}

function categoryLabel(category) {
  const cat = CLAIM_CATEGORIES[category];
  return cat ? cat.label : category;
}

// Medical subcategories that carry a configurable annual limit — used to
// build the Company Settings form and the remaining-balance summary.
const MEDICAL_LIMIT_FIELDS = Object.entries(CLAIM_CATEGORIES.medical.subcategories)
  .filter(([, sub]) => sub.medicalLimitField)
  .map(([key, sub]) => ({ subcategory: key, field: sub.medicalLimitField, label: sub.label }));

module.exports = {
  CLAIM_CATEGORIES,
  CATEGORY_KEYS,
  isValidCategory,
  isValidSubcategory,
  subcategoryLabel,
  categoryLabel,
  MEDICAL_LIMIT_FIELDS,
};
