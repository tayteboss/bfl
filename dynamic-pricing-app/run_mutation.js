import fetch from "node-fetch";

const mutation = `
mutation {
  cartTransformCreate(functionId: "8549077a-a8d0-17af-6f97-0497ca93c2b4befadff8") {
    cartTransform {
      id
      functionId
    }
    userErrors {
      field
      message
    }
  }
}
`;

async function run() {
  // Try using the CLI to run it with the app's scopes instead of GraphiQL
  console.log("We'll use shopify app env show to get credentials instead");
}

run();
