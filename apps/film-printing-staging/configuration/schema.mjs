// Native Admin fields. Units are explicit; JSON is limited to provenance/origin.
const field = (key, type = 'single_line_text_field', required = true, validations = []) => ({
  key, name: key.replaceAll('_', ' '), type, required, validations,
});
const positive = key => field(key, 'number_decimal', true, [{ name: 'min', value: '0.000001' }]);
const common = [field('label'), field('enabled', 'boolean'), field('disabled_reason', 'multi_line_text_field', false), field('provenance', 'json')];
export const definitions = [
  { type: 'bfl_print_package', name: 'BFL print package', fieldDefinitions: [...common,
    field('kind'), positive('length_in'), positive('width_in'), positive('height_in'), positive('empty_weight_oz'),
    field('dimensions_status'), field('weight_status')] },
  { type: 'bfl_print_rule', name: 'BFL print packing rule', fieldDefinitions: [...common,
    field('service'), field('size_key'), field('lab'), field('paper', 'single_line_text_field', false),
    field('package_id', 'single_line_text_field', false),
    field('capacity', 'number_integer', false, [{ name: 'min', value: '1' }, { name: 'max', value: '10000' }]),
    field('print_weight_oz', 'number_decimal', false, [{ name: 'min', value: '0.000001' }]), field('capacity_status'), field('weight_status')] },
  { type: 'bfl_print_lab', name: 'BFL print lab', fieldDefinitions: [...common,
    field('location_id', 'single_line_text_field', false), field('origin', 'json', false), field('origin_status')] },
  { type: 'bfl_print_policy', name: 'BFL print carrier policy', fieldDefinitions: [...common,
    field('provider'), field('service'), field('rate_source'), field('currency'),
    field('markup_basis_points', 'number_integer'), field('markup_cents', 'number_integer'),
    field('coverage'), field('failure'), field('pickup'), field('sharing'), field('rate_access'),
    field('shippo', 'json', false)] },
].map(definition => ({ ...definition, displayNameKey: 'label', access: { storefront: 'NONE' },
  description: 'Film Printing staging draft. Edit in Admin; validate/publish separately. No secrets. Saving does not change the active configuration.' }));
export const groupTypes = { packages: 'bfl_print_package', rules: 'bfl_print_rule', labs: 'bfl_print_lab', policies: 'bfl_print_policy' };
export const STORE = 'bellows-film-printing-staging.myshopify.com';
export const APP = 'gid://shopify/App/436988772353';
export const CLIENT = '002722c8effe5d2e3243467181b45833';
export const NAMESPACE = 'bfl_printing';
