// Countries and their states, shared by the server (require) and the browser
// (<script>, as window.TonamentRegions) so tournament locations are spelled
// the same way everywhere and can be filtered reliably. To add a country, add
// one line: its states, or null when it has none.

(function (root, factory) {
  const regions = factory();
  if (typeof module === 'object' && module.exports) module.exports = regions;
  else root.TonamentRegions = regions;
})(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const COUNTRIES = {
    India: [
      'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana',
      'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur',
      'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana',
      'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
      'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi',
      'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry',
    ],
    'United States': [
      'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
      'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas',
      'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi',
      'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
      'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
      'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
      'West Virginia', 'Wisconsin', 'Wyoming',
    ],
    'United Kingdom': ['England', 'Scotland', 'Wales', 'Northern Ireland'],
    Canada: [
      'Alberta', 'British Columbia', 'Manitoba', 'New Brunswick', 'Newfoundland and Labrador', 'Nova Scotia',
      'Ontario', 'Prince Edward Island', 'Quebec', 'Saskatchewan', 'Northwest Territories', 'Nunavut', 'Yukon',
    ],
    Australia: [
      'Australian Capital Territory', 'New South Wales', 'Northern Territory', 'Queensland', 'South Australia',
      'Tasmania', 'Victoria', 'Western Australia',
    ],
    Malaysia: [
      'Johor', 'Kedah', 'Kelantan', 'Malacca', 'Negeri Sembilan', 'Pahang', 'Penang', 'Perak', 'Perlis', 'Sabah',
      'Sarawak', 'Selangor', 'Terengganu', 'Kuala Lumpur', 'Labuan', 'Putrajaya',
    ],
    'United Arab Emirates': ['Abu Dhabi', 'Ajman', 'Dubai', 'Fujairah', 'Ras Al Khaimah', 'Sharjah', 'Umm Al Quwain'],
    Indonesia: [
      'Aceh', 'Bali', 'Bangka Belitung Islands', 'Banten', 'Bengkulu', 'Central Java', 'Central Kalimantan',
      'Central Papua', 'Central Sulawesi', 'East Java', 'East Kalimantan', 'East Nusa Tenggara', 'Gorontalo',
      'Highland Papua', 'Jakarta', 'Jambi', 'Lampung', 'Maluku', 'North Kalimantan', 'North Maluku',
      'North Sulawesi', 'North Sumatra', 'Papua', 'Riau', 'Riau Islands', 'South Kalimantan', 'South Papua',
      'South Sulawesi', 'South Sumatra', 'Southeast Sulawesi', 'Southwest Papua', 'West Java',
      'West Kalimantan', 'West Nusa Tenggara', 'West Papua', 'West Sulawesi', 'West Sumatra', 'Yogyakarta',
    ],
    Singapore: null,
    'Sri Lanka': null,
    Nepal: null,
    Bangladesh: null,
  };

  return {
    countries: Object.keys(COUNTRIES),
    defaultCountry: 'India',
    // The country's states, or null when it has none (or isn't listed).
    regionsFor: (country) => COUNTRIES[country] || null,
    isListed: (country) => Object.prototype.hasOwnProperty.call(COUNTRIES, country),
  };
});
