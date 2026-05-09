const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'public', 'dist'),
    // Content-hashed filenames so any source change forces the
    // browser/CDN to fetch the new bundle. html-webpack-plugin
    // rewrites the served index.html with the right hash on every
    // build, so users never get a stale bundle paired with new HTML
    // (or vice-versa).
    filename: 'bundle.[contenthash].js',
    publicPath: '/dist/',
    clean: true, // wipe old hashed files from public/dist on each build
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx)$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env', '@babel/preset-react'],
          },
        },
      },
      {
        test: /\.css$/,
        use: [
          MiniCssExtractPlugin.loader,
          'css-loader',
          'postcss-loader',
        ],
      },
    ],
  },
  plugins: [
    new MiniCssExtractPlugin({ filename: 'bundle.[contenthash].css' }),
    // Generates ../index.html in public/ from the template, with
    // the hashed bundle.js / bundle.css <script> + <link> tags
    // injected automatically.
    new HtmlWebpackPlugin({
      template: path.resolve(__dirname, 'public', 'index.template.html'),
      filename: path.resolve(__dirname, 'public', 'index.html'),
      inject: 'body',
      scriptLoading: 'defer',
      cache: false,
    }),
  ],
  resolve: {
    extensions: ['.js', '.jsx', '.json']
  },
};
