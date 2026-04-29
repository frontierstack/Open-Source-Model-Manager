const path = require('path');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = {
    entry: './src/index.js',
    output: {
        path: path.resolve(__dirname, 'public'),
        filename: 'bundle.js',
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
            // Emit the pdfjs worker as a separate asset so we can point
            // GlobalWorkerOptions.workerSrc at it. Without this rule webpack
            // tries to inline-bundle the worker into the main bundle and
            // pdfjs's runtime check throws "fake worker" errors.
            {
                test: /pdf\.worker(\.min)?\.m?js$/,
                type: 'asset/resource',
                generator: { filename: 'pdf.worker.[contenthash].mjs' },
            },
        ],
    },
    plugins: [
        new MiniCssExtractPlugin({
            filename: 'styles.css',
        }),
    ],
    resolve: {
        extensions: ['.js', '.jsx'],
    },
    performance: {
        hints: false,
        maxEntrypointSize: 2048000,
        maxAssetSize: 2048000,
    },
};
