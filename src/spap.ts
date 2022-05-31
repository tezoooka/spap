import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { parse as parseArn, build as buildArn } from '@aws-sdk/util-arn-parser';
import { Readable } from 'stream';

//
//   SPAP is neither Pen-Pinapple-Apple-Pen nor STAP-Cell, Single-Page-Application-Publisher.
//

type Content = {
    body: string,
    contentType?: string | undefined,
    cacheControl?: string | undefined,
    isBase64Encoded: boolean,
    arn?: string,
}


const env = new class {
    readonly contentsLocation = process.env['SPAP_CONTENTS_LOCATION'] || '';
    readonly reWrite404 = process.env['SPAP_REWRITE404'];
}


const s3ObjectReader = new class {

    // This class is instantiated only once when Lambda-Container is initialized, 
    // and will be reused holding the bucket-name and object-prefix.

    s3Client = new S3Client({});
    readonly s3bucket: string;
    readonly s3prefix: string;

    constructor() {
        const paths = this.locateS3Object();
        this.s3bucket = paths.shift() || '';
        this.s3prefix = paths.join('/');
    }

    private locateS3Object() {

        console.log(`Contents location: ${env.contentsLocation}`)

        const isArn = () => env.contentsLocation.startsWith("arn:aws:s3:");
        const isS3Url = () => env.contentsLocation.startsWith("s3://");

        let paths: string[];
        if (isArn()) {
            const arn = parseArn(env.contentsLocation)
            paths = arn.resource.split("/");

        } else if (isS3Url()) {
            paths = env.contentsLocation.replace(/^s3:\/\//, '').split("/");

        } else {
            console.error("Unknown contents location format - " + env.contentsLocation)
            throw "Missing contents location."
        }

        return paths;
    }


    public async read(objectName: string): Promise<Content | null> {

        try {

            const s3Obj = {
                Bucket: this.s3bucket,
                Key: this.toS3Key(objectName),
            };

            console.info(JSON.stringify(s3Obj));

            const object = await this.s3Client.send(new GetObjectCommand(s3Obj));
            const bodyBuffer = await this.readBody(object.Body as Readable);

            const contentType = object.ContentType;
            const isBase64 = this.isBinaryMedia(contentType || '');

            return {
                body: bodyBuffer.toString(isBase64 ? 'base64' : 'utf8'),
                contentType: contentType,
                cacheControl: object.CacheControl,
                isBase64Encoded: isBase64,
                arn: buildArn({ service: 's3', region: '', accountId: '', resource: s3Obj.Bucket + '/' + s3Obj.Key }),
            }

        } catch (e: any) {
            if (e?.$metadata?.httpStatusCode == 404) {
                return null
            }
            console.error(JSON.stringify(e));
            throw e;
        }

    }

    private isBinaryMedia(contentType: string): boolean {
        const mediaType = contentType.split('/')[0] || ''
        return ['image', 'video', 'audio'].includes(mediaType)
    }

    private async readBody(stream: Readable): Promise<Buffer> {
        return await new Promise((resolve, reject) => {
            const chunks: Uint8Array[] = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
    }

    private toS3Key(objectName: string): string {

        // Concatenate simply prefix and objectName with delimiter 
        const concat = this.s3prefix + '/' + objectName;

        // Eliminate dupulicate slash, and leftside slash
        const eliminateSla = concat.replace(/\/+/g, '/');
        const key = eliminateSla.replace(/^\//, '');

        return key;

    }

}

class response200 implements APIGatewayProxyResult {

    public readonly statusCode: number;
    public readonly headers: { [header: string]: string };
    public readonly body: string;
    public readonly isBase64Encoded: boolean;

    constructor(content: Content) {
        this.statusCode = 200;
        this.headers = this.createHeaders(content);
        this.body = content.body;
        this.isBase64Encoded = content.isBase64Encoded;
    }

    private createHeaders(content: Content) {

        let headers: { [header: string]: string } = {};

        if (content.cacheControl) {
            headers = { ...headers, ... { 'Cache-Control': content.cacheControl } }
        }
        if (content.contentType) {
            headers = { ...headers, ... { 'Content-Type': content.contentType } }
        }
        if (content.arn) {
            headers = { ...headers, ... { 'X-SPAP-Origin-Arn': content.arn } }
        }
        return headers;
    }
}

class response404 implements APIGatewayProxyResult {

    public readonly statusCode: number;
    public readonly headers: { [header: string]: string };
    public readonly body: string;
    public readonly isBase64Encoded: boolean;

    constructor(path: string) {
        this.statusCode = 404;
        this.headers = {
            'Content-Type': 'text/html'
        }
        this.body = `<html><h1>404</h1><h3>Not found</h3><p> The requested URL ${path} was not found.</p></html>`
        this.isBase64Encoded = false;
    }

}

// Lambda Handler function
export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

    console.info(JSON.stringify(event));

    // remove "{proxy+}" from API resource setting, extract just a base-path.
    const resource = event.resource;
    const basePath = resource.replace('{proxy+}', '');

    // remove base-path from requested path, get a simple object-path/name.
    const urlPath = event.path;
    const specificResource = urlPath.replace(basePath, '')

    // Assume "index.html" if object-name ends with "/"
    const dirIndex = specificResource.endsWith("/") ? "index.html" : "";
    const objectName = specificResource + dirIndex;

    // Read content from s3
    let content = await s3ObjectReader.read(objectName);

    if (!content && env.reWrite404) {
        content = await s3ObjectReader.read(env.reWrite404);
        console.info(`${objectName} not found, rewrited to ${env.reWrite404}.`)
    }

    // Make a response
    const response = content ?
        new response200(content) :
        new response404(urlPath);

    return response;

}

