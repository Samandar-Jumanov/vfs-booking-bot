const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    'background/service-worker': './background/service-worker.ts',
    'content/vfs-bridge': './content/vfs-bridge.ts',
    'popup/popup': './popup/popup.tsx',
    'options/options': './options/options.tsx'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
    clean: true
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js']
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/
      }
    ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'popup/popup.html', to: 'popup/popup.html' },
        { from: 'popup/popup.css', to: 'popup/popup.css' },
        { from: 'options/options.html', to: 'options/options.html' },
        { from: 'options/options.css', to: 'options/options.css' },
        { from: 'icons', to: 'icons' }
      ]
    })
  ],
  optimization: {
    minimize: false
  }
};
