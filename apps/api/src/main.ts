import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { RequestMethod, ValidationPipe, VersioningType } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 } });

  const config = app.get(ConfigService);
  const port = config.get<number>('API_PORT', 3001);
  const prefix = config.get<string>('API_PREFIX', 'api');
  const webOrigin = config.get<string>('WEB_ORIGIN', 'http://localhost:3000');
  const nodeEnv = config.get<string>('NODE_ENV', 'development');

  app.setGlobalPrefix(prefix, {
    exclude: [{ path: "metrics", method: RequestMethod.GET }],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.enableCors({
    origin: webOrigin,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Block GraphQL introspection in production
  if (nodeEnv === 'production') {
    const fastify = app.getHttpAdapter().getInstance() as any;
    fastify.addHook('preHandler', async (request: any, reply: any) => {
      const body = request.body;
      const rawQuery =
        (body && typeof body === 'object' && body.query) ||
        (typeof body === 'string' ? body : null) ||
        (request.query && request.query.query) ||
        null;

      if (
        typeof rawQuery === 'string' &&
        /\b___schema|__type\b/i.test(rawQuery)
      ) {
        await reply.code(400).send({
          errors: [{ message: 'GraphQL introspection is not allowed in production.' }],
        });
        return;
      }
    });
  }

  // Only enable Swagger in development and staging environments
  if (nodeEnv !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("SaviTools API")
      .setDescription("Developer infrastructure for the Stellar ecosystem")
      .setVersion("1.0")
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(`${prefix}/docs`, app, document);
  }

  await app.listen(port, "0.0.0.0");
  console.log(`SaviTools API running on http://localhost:${port}/${prefix}`);
  console.log(`Swagger docs at http://localhost:${port}/${prefix}/docs`);
}

bootstrap();
