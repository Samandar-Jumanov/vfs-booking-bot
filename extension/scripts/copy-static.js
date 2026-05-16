const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
  throw new Error('dist was not created by webpack');
}

console.log(`Extension bundle ready at ${dist}`);
